/** Linear Life -> Google Calendar. Linear remains the source of truth. */
const CONFIG = Object.freeze({
  LINEAR_API_URL: 'https://api.linear.app/graphql',
  LINEAR_PROJECT_ID: '4eaf63bf-9834-40ff-8358-e2407127b975', // Life
  GOOGLE_CALENDAR_NAME: 'Linear',
  TIMEZONE: 'Asia/Tokyo',
  SYNC_HOURS: [6, 9, 12, 15, 18, 21],
  SYNC_SOURCE: 'linear-life-calendar-v1',
});

/** Requires LINEAR_API_KEY and the Advanced Calendar service (v3).
 * Run as the account that installed the old Tasks triggers.
 */
function setupSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another sync is running. Retry setup later.');
  try {
    const issues = fetchLifeIssuesFromLinear_();
    const properties = PropertiesService.getScriptProperties();
    let calendarId = properties.getProperty('GOOGLE_CALENDAR_ID');
    if (!calendarId) {
      const calendar = Calendar.Calendars.insert({
        summary: CONFIG.GOOGLE_CALENDAR_NAME,
        timeZone: CONFIG.TIMEZONE,
      });
      calendarId = calendar.id;
      properties.setProperty('GOOGLE_CALENDAR_ID', calendarId);
    }
    // Validate both connections before removing the old schedule.
    Calendar.Calendars.get(calendarId);
    const events = listSyncedCalendarEvents_(calendarId);
    removeSyncTriggers_();
    reconcileCalendar_(calendarId, issues, events);
    installSyncTriggers_();
    console.log(`Setup complete. Sync hours: ${CONFIG.SYNC_HOURS.join(', ')} ${CONFIG.TIMEZONE}.`);
  } finally {
    lock.releaseLock();
  }
}

function resetSyncTriggers() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another sync is running. Retry later.');
  try {
    getGoogleCalendarId_();
    installSyncTriggers_();
  } finally {
    lock.releaseLock();
  }
}

function removeSyncTriggers() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another sync is running. Retry later.');
  try {
    removeSyncTriggers_();
  } finally {
    lock.releaseLock();
  }
}

function installSyncTriggers_() {
  const handlers = ['syncLinearToGoogleTasks', 'syncLinearToGoogleCalendar'];
  const previous = ScriptApp.getProjectTriggers()
    .filter((trigger) => handlers.includes(trigger.getHandlerFunction()));
  const created = [];
  try {
    // Keep the current schedule alive if creating its replacement fails.
    for (const hour of CONFIG.SYNC_HOURS) {
      created.push(ScriptApp.newTrigger('syncLinearToGoogleCalendar')
        .timeBased().atHour(hour).nearMinute(0).everyDays(1)
        .inTimezone(CONFIG.TIMEZONE).create());
    }
  } catch (error) {
    created.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
    throw error;
  }
  previous.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  PropertiesService.getUserProperties().setProperty('SYNC_TRIGGER_SCHEDULE',
    `${CONFIG.TIMEZONE}:${CONFIG.SYNC_HOURS.join(',')}`);
}

function updateSyncTriggersIfNeeded_() {
  const triggers = ScriptApp.getProjectTriggers();
  const current = triggers.filter((trigger) => trigger.getHandlerFunction() === 'syncLinearToGoogleCalendar');
  // A manual sync must not restart a schedule the user has stopped.
  if (current.length === 0) return;
  const schedule = `${CONFIG.TIMEZONE}:${CONFIG.SYNC_HOURS.join(',')}`;
  if (PropertiesService.getUserProperties().getProperty('SYNC_TRIGGER_SCHEDULE') !== schedule ||
      current.length !== CONFIG.SYNC_HOURS.length ||
      triggers.some((trigger) => trigger.getHandlerFunction() === 'syncLinearToGoogleTasks')) {
    installSyncTriggers_();
    console.log(`Sync schedule updated: ${schedule}.`);
  }
}

function removeSyncTriggers_() {
  const handlers = ['syncLinearToGoogleTasks', 'syncLinearToGoogleCalendar'];
  ScriptApp.getProjectTriggers()
    .filter((trigger) => handlers.includes(trigger.getHandlerFunction()))
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

function syncLinearToGoogleCalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Another sync is running. Skipping.');
    return;
  }
  try {
    const issues = fetchLifeIssuesFromLinear_();
    const calendarId = getGoogleCalendarId_();
    const events = listSyncedCalendarEvents_(calendarId);
    reconcileCalendar_(calendarId, issues, events);
    updateSyncTriggersIfNeeded_();
  } finally {
    lock.releaseLock();
  }
}

function getGoogleCalendarId_() {
  const calendarId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CALENDAR_ID');
  if (!calendarId) throw new Error('Missing GOOGLE_CALENDAR_ID. Run setupSync first.');
  Calendar.Calendars.get(calendarId); // Never silently replace an inaccessible calendar.
  return calendarId;
}

function listSyncedCalendarEvents_(calendarId) {
  const events = [];
  let pageToken;
  do {
    const page = Calendar.Events.list(calendarId, {
      maxResults: 2500,
      showDeleted: false,
      privateExtendedProperty: [`syncSource=${CONFIG.SYNC_SOURCE}`],
      ...(pageToken ? { pageToken } : {}),
    });
    if (!page || (page.items !== undefined && !Array.isArray(page.items))) {
      throw new Error('Invalid Calendar events response. Sync stopped.');
    }
    events.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

function reconcileCalendar_(calendarId, issues, events) {
  // Build every desired event before writes, so invalid dates cannot cause partial cleanup.
  const desiredById = new Map(issues.filter(isActionableIssue_)
    .map((issue) => [issue.id, buildCalendarEvent_(issue)]));
  const existingById = new Map();
  const duplicates = [];
  for (const event of events) {
    const properties = event.extendedProperties && event.extendedProperties.private;
    if (event.status === 'cancelled' || !properties ||
        properties.syncSource !== CONFIG.SYNC_SOURCE || !properties.linearIssueId) continue;
    const current = existingById.get(properties.linearIssueId);
    if (!current) {
      existingById.set(properties.linearIssueId, event);
    } else if ((event.updated || '') > (current.updated || '')) {
      duplicates.push(current);
      existingById.set(properties.linearIssueId, event);
    } else {
      duplicates.push(event);
    }
  }

  const counts = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  for (const [issueId, desired] of desiredById) {
    const existing = existingById.get(issueId);
    if (!existing) {
      Calendar.Events.insert(desired, calendarId);
      counts.created++;
    } else if (needsEventUpdate_(existing, desired)) {
      // Explicitly clear time-based fields if an all-day event was edited on the calendar.
      Calendar.Events.patch({
        ...desired,
        start: { ...desired.start, dateTime: null, timeZone: null },
        end: { ...desired.end, dateTime: null, timeZone: null },
        recurrence: null,
      }, calendarId, existing.id);
      counts.updated++;
    } else {
      counts.unchanged++;
    }
  }
  // Cleanup follows successful reads and upserts; only marked events are eligible.
  const obsolete = [...existingById].filter(([id]) => !desiredById.has(id)).map(([, event]) => event);
  for (const event of [...duplicates, ...obsolete]) {
    Calendar.Events.remove(calendarId, event.id);
    counts.deleted++;
  }
  console.log(JSON.stringify({ fetchedFromLinear: issues.length, ...counts }));
}

/** Read-only preview; does not require a calendar or write any events. */
function previewLinearTasks() {
  const preview = fetchLifeIssuesFromLinear_().map((issue) => ({
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state && issue.state.name,
    dueDate: issue.dueDate || null,
    labels: getLabelNames_(issue),
    actionable: isActionableIssue_(issue),
  }));
  console.log(JSON.stringify(preview, null, 2));
}

function isActionableIssue_(issue) {
  const stateType = issue.state && issue.state.type;
  return Boolean(issue.dueDate) && (stateType === 'unstarted' || stateType === 'started');
}

function getLabelNames_(issue) {
  return ((issue.labels && issue.labels.nodes) || []).map((label) => label.name);
}

function buildCalendarEvent_(issue) {
  const date = new Date(`${issue.dueDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate) ||
      !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== issue.dueDate) {
    throw new Error(`Invalid due date for ${issue.identifier}. Sync stopped.`);
  }
  date.setUTCDate(date.getUTCDate() + 1);
  const labels = getLabelNames_(issue);
  return {
    summary: `[${issue.identifier}] ${issue.title}`,
    description: [
      'Synced from Linear. Linear is the source of truth.',
      `Issue: ${issue.identifier}`,
      `Status: ${issue.state.name}`,
      labels.length ? `Labels: ${labels.join(', ')}` : null,
      `URL: ${issue.url}`,
    ].filter(Boolean).join('\n'),
    start: { date: issue.dueDate },
    end: { date: date.toISOString().slice(0, 10) },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { syncSource: CONFIG.SYNC_SOURCE, linearIssueId: issue.id } },
  };
}

function needsEventUpdate_(existing, desired) {
  return existing.summary !== desired.summary || existing.description !== desired.description ||
    !existing.start || existing.start.date !== desired.start.date || Boolean(existing.start.dateTime) ||
    !existing.end || existing.end.date !== desired.end.date || Boolean(existing.end.dateTime) ||
    Boolean(existing.recurrence && existing.recurrence.length) ||
    existing.transparency !== desired.transparency ||
    !existing.reminders || existing.reminders.useDefault !== false ||
    Boolean(existing.reminders.overrides && existing.reminders.overrides.length);
}

function fetchLifeIssuesFromLinear_() {
  const projectId = CONFIG.LINEAR_PROJECT_ID.replace(/"/g, '\\"');
  const query = `
    query LifeIssues($after: String) {
      viewer {
        assignedIssues(
          first: 100
          after: $after
          filter: { project: { id: { eq: "${projectId}" } } }
        ) {
          nodes {
            id
            identifier
            title
            url
            dueDate
            priority
            state {
              name
              type
            }
            labels {
              nodes {
                name
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  const issues = [];
  let after = null;

  do {
    const data = linearGraphql_(query, { after });
    const connection = data.viewer.assignedIssues;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo ||
        typeof connection.pageInfo.hasNextPage !== 'boolean' ||
        (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after))) {
      throw new Error('Incomplete Linear response. Sync stopped.');
    }
    issues.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return issues;
}

function linearGraphql_(query, variables) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('LINEAR_API_KEY');
  if (!apiKey) {
    throw new Error(
      'Missing Script Property LINEAR_API_KEY. Add your Linear personal API key in Apps Script Project Settings > Script properties.'
    );
  }

  const payload = JSON.stringify({ query, variables: variables || {} });
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = UrlFetchApp.fetch(CONFIG.LINEAR_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: apiKey,
      },
      payload,
      muteHttpExceptions: true,
    });

    const status = response.getResponseCode();
    const text = response.getContentText();

    if (status === 429 || status >= 500) {
      lastError = new Error(`Linear API temporary error ${status}: ${text}`);
      if (attempt < 3) {
        Utilities.sleep(attempt * 1000);
        continue;
      }
      throw lastError;
    }

    if (status < 200 || status >= 300) {
      throw new Error(`Linear API HTTP ${status}: ${text}`);
    }

    const body = JSON.parse(text);
    if (body.errors && body.errors.length) {
      throw new Error(
        `Linear GraphQL error: ${body.errors.map((e) => e.message).join(' | ')}`
      );
    }

    if (!body.data) {
      throw new Error('Linear API returned no data.');
    }

    return body.data;
  }

  throw lastError || new Error('Linear API request failed.');
}
