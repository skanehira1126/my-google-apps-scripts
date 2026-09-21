const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../コード.js`, 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const issue = (overrides = {}) => ({
  id: 'issue-1', identifier: 'MIH-123', title: '買い物',
  url: 'https://linear.app/example/issue/MIH-123', dueDate: '2026-09-10',
  createdAt: '2026-09-01T00:00:00.000Z', startedAt: null,
  state: { type: 'unstarted', name: 'Todo' }, labels: { nodes: [] },
  stateHistory: { nodes: [], pageInfo: { hasNextPage: false } }, ...overrides,
});
function harness() {
  const state = {
    issues: [issue()], events: [], writes: [], logs: [], sleeps: [], calendarCreates: 0,
    properties: { LINEAR_API_KEY: '<test-key>', GOOGLE_CALENDAR_ID: 'test-calendar' },
    userProperties: {}, triggerCreates: 0,
    triggers: [], locked: false, releases: 0, eventReads: [], linearReads: [], nextId: 0,
  };
  const context = vm.createContext({
    console: { log: (message) => state.logs.push(message) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => state.properties[key] || null,
        setProperty: (key, value) => { state.properties[key] = value; },
      }),
      getUserProperties: () => ({
        getProperty: (key) => state.userProperties[key] || null,
        setProperty: (key, value) => { state.userProperties[key] = value; },
      }),
    },
    LockService: { getScriptLock: () => ({
      tryLock: () => !state.locked, releaseLock: () => { state.releases++; },
    }) },
    Utilities: {
      sleep: (duration) => state.sleeps.push(duration),
      formatDate: (date, zone) => {
        assert.equal(zone, 'Asia/Tokyo');
        return new Intl.DateTimeFormat('sv-SE', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(date);
      },
    },
    UrlFetchApp: { fetch: (_url, options) => {
      const { variables } = JSON.parse(options.payload);
      const index = variables.after ? Number(variables.after) : 0;
      state.linearReads.push(index);
      if (state.linearFail === index) throw new Error('Linear unavailable');
      const status = state.statuses?.shift() || 200;
      const body = state.linearBody || { data: { viewer: { assignedIssues: {
        nodes: state.issues.slice(index, index + 1),
        pageInfo: { hasNextPage: index + 1 < state.issues.length, endCursor: String(index + 1) },
      } } } };
      return { getResponseCode: () => status, getContentText: () => JSON.stringify(body) };
    } },
    Calendar: {
      Calendars: {
        get: (id) => { if (state.calendarFail) throw new Error('Calendar inaccessible'); return { id }; },
        insert: () => { state.calendarCreates++; return { id: 'created-calendar' }; },
      },
      Events: {
        list: (_id, options) => {
          assert.equal(options.timeMin, undefined);
          assert.equal(options.timeMax, undefined);
          assert.equal(options.privateExtendedProperty[0], 'syncSource=linear-life-calendar-v1');
          const index = Number(options.pageToken || 0);
          state.eventReads.push(index);
          if (state.eventFail === index) throw new Error('Calendar list unavailable');
          return { items: copy(state.events.slice(index, index + 1)),
            ...(index + 1 < state.events.length ? { nextPageToken: String(index + 1) } : {}) };
        },
        insert: (resource) => {
          if (state.writeFail) throw new Error('Calendar write unavailable');
          state.writes.push('insert');
          state.events.push({ ...copy(resource), id: `event-${++state.nextId}` });
        },
        patch: (resource, _calendarId, id) => {
          if (state.writeFail) throw new Error('Calendar write unavailable');
          state.writes.push('patch');
          const event = state.events.find((event) => event.id === id);
          Object.assign(event, copy(resource));
        },
        remove: (_calendarId, id) => {
          state.writes.push('remove');
          state.events = state.events.filter((event) => event.id !== id);
        },
      },
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers,
      deleteTrigger: (trigger) => { state.triggers = state.triggers.filter((item) => item !== trigger); },
      newTrigger: (handler) => {
        const trigger = { handler, getHandlerFunction: () => handler };
        const builder = {
          timeBased: () => builder, atHour: (hour) => { trigger.hour = hour; return builder; },
          nearMinute: () => builder, everyDays: () => builder,
          inTimezone: (zone) => { trigger.zone = zone; return builder; },
          create: () => {
            if (++state.triggerCreates === state.triggerCreateFailAt) throw new Error('Trigger creation failed');
            state.triggers.push(trigger);
            return trigger;
          },
        };
        return builder;
      },
    },
  });
  vm.runInContext(source, context);
  return { state, api: context };
}

test('期限と状態で対象を判定し、Waitingは除外しない', () => {
  const { api } = harness();
  for (const type of ['unstarted', 'started', 'backlog', 'completed', 'canceled']) {
    for (const dueDate of [null, '2020-01-01']) {
      const item = issue({ dueDate, state: { type, name: type }, labels: { nodes: [{ name: 'Waiting' }] } });
      assert.equal(api.isActionableIssue_(item), Boolean(dueDate) && ['unstarted', 'started'].includes(type));
    }
  }
});

test('終日イベントの日付境界、表示、通知なし', () => {
  const { api } = harness();
  for (const [start, end] of [['2026-01-31', '2026-02-01'], ['2026-12-31', '2027-01-01'], ['2028-02-28', '2028-02-29'], ['2028-02-29', '2028-03-01']]) {
    const event = api.buildCalendarEvent_(issue({ dueDate: start }));
    assert.equal(event.start.date, start);
    assert.equal(event.end.date, end);
    assert.equal(event.summary, '[MIH-123] 買い物');
    assert.match(event.description, /https:\/\/linear.app/);
    assert.equal(event.transparency, 'transparent');
    assert.equal(event.reminders.useDefault, false);
    assert.equal(event.reminders.overrides.length, 0);
  }
  assert.throws(() => api.buildCalendarEvent_(issue({ dueDate: '2026-02-30' })), /Invalid due date/);
});

test('Calendar Rangeラベルは最新のTodo開始日から期限日までの帯にする', () => {
  const { api } = harness();
  const item = issue({
    labels: { nodes: [{ name: 'Calendar Range' }] },
    state: { type: 'started', name: 'In Progress' },
    startedAt: '2026-09-05T15:00:00.000Z',
    stateHistory: {
      nodes: [
        { state: { name: 'Todo', type: 'unstarted' }, startedAt: '2026-08-30T15:00:00.000Z', endedAt: '2026-09-01T00:00:00.000Z' },
        { state: { name: 'Todo', type: 'unstarted' }, startedAt: '2026-09-02T15:00:00.000Z', endedAt: '2026-09-05T15:00:00.000Z' },
      ],
      pageInfo: { hasNextPage: false },
    },
  });
  const event = api.buildCalendarEvent_(item);
  assert.equal(event.start.date, '2026-09-03');
  assert.equal(event.end.date, '2026-09-11');
});

test('Calendar RangeラベルはTodo履歴がなければ着手日時、作成日時の順に使う', () => {
  const { api } = harness();
  const label = { nodes: [{ name: 'Calendar Range' }] };
  assert.equal(api.buildCalendarEvent_(issue({
    labels: label,
    state: { type: 'started', name: 'In Progress' },
    startedAt: '2026-09-04T15:00:00.000Z',
  })).start.date, '2026-09-05');
  assert.equal(api.buildCalendarEvent_(issue({ labels: label })).start.date, '2026-09-01');
});

test('Calendar Rangeの開始が期限後なら期限当日の単日予定にする', () => {
  const { api } = harness();
  const event = api.buildCalendarEvent_(issue({
    labels: { nodes: [{ name: 'Calendar Range' }] },
    createdAt: '2026-09-11T00:00:00.000Z',
  }));
  assert.equal(event.start.date, '2026-09-10');
  assert.equal(event.end.date, '2026-09-11');
});

test('Calendar Rangeの状態履歴が不完全なら同期を停止する', () => {
  const { api, state } = harness();
  state.issues[0] = issue({
    labels: { nodes: [{ name: 'Calendar Range' }] },
    stateHistory: { nodes: [], pageInfo: { hasNextPage: true } },
  });
  assert.throws(() => api.syncLinearToGoogleCalendar(), /state history exceeds/);
  assert.deepEqual(state.writes, []);
});

test('全ページ取得、2回同期の冪等性、同じイベントの期限・タイトル更新', () => {
  const { api, state } = harness();
  state.issues.push(issue({ id: 'issue-2' }));
  api.syncLinearToGoogleCalendar();
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.linearReads, [0, 1]);
  state.writes = [];
  api.syncLinearToGoogleCalendar();
  assert.deepEqual(state.writes, []);
  assert.ok(state.eventReads.includes(1));
  const id = state.events[0].id;
  state.issues[0].dueDate = '2026-12-31';
  state.issues[0].title = '変更後';
  api.syncLinearToGoogleCalendar();
  assert.equal(state.events[0].id, id);
  assert.equal(state.events[0].end.date, '2027-01-01');
  assert.equal(state.events[0].summary, '[MIH-123] 変更後');
  assert.deepEqual(state.writes, ['patch']);
});

test('Calendar Rangeラベルの追加で同じイベントを期間表示へ更新する', () => {
  const { api, state } = harness();
  api.syncLinearToGoogleCalendar();
  const id = state.events[0].id;
  state.writes = [];
  state.issues[0].labels.nodes.push({ name: 'Calendar Range' });
  state.issues[0].stateHistory.nodes.push({
    state: { name: 'Todo', type: 'unstarted' },
    startedAt: '2026-09-02T00:00:00.000Z',
    endedAt: null,
  });
  api.syncLinearToGoogleCalendar();
  assert.equal(state.events[0].id, id);
  assert.equal(state.events[0].start.date, '2026-09-02');
  assert.deepEqual(state.writes, ['patch']);
});

for (const reason of ['期限削除', 'Backlog', 'Done', 'Canceled', '担当変更', 'Project変更', '削除・アーカイブ']) {
  test(`${reason}で同期イベントを削除し、手動イベントは保護`, () => {
    const { api, state } = harness();
    api.syncLinearToGoogleCalendar();
    state.events.push({ id: 'manual', summary: '手動予定' });
    if (reason === '期限削除') state.issues[0].dueDate = null;
    else if (['Backlog', 'Done', 'Canceled'].includes(reason)) {
      state.issues[0].state.type = { Backlog: 'backlog', Done: 'completed', Canceled: 'canceled' }[reason];
    } else state.issues = []; // viewer/project-filtered response no longer contains this issue.
    api.syncLinearToGoogleCalendar();
    assert.deepEqual(state.events, [{ id: 'manual', summary: '手動予定' }]);
  });
}

test('重複の整理、別の同期元と識別子のないイベントの保護', () => {
  const { api, state } = harness();
  api.syncLinearToGoogleCalendar();
  state.events.push({ ...copy(state.events[0]), id: 'newer', updated: '2026-09-10' });
  state.events.push({ id: 'other', extendedProperties: { private: { syncSource: 'other', linearIssueId: 'issue-1' } } });
  state.events.push({ id: 'incomplete', extendedProperties: { private: { syncSource: 'linear-life-calendar-v1' } } });
  api.syncLinearToGoogleCalendar();
  assert.deepEqual(state.events.map((event) => event.id), ['newer', 'other', 'incomplete']);
});

for (const failure of ['linear', 'calendar', 'malformed', 'write', 'invalid-date']) {
  test(`${failure}の失敗時に既存イベントを削除しない`, () => {
    const { api, state } = harness();
    api.syncLinearToGoogleCalendar();
    state.events.push({ ...copy(state.events[0]), id: 'duplicate' });
    state.writes = [];
    state.issues = [issue({ id: 'replacement' }), issue({ id: 'second' })];
    if (failure === 'linear') state.linearFail = 1;
    if (failure === 'calendar') state.eventFail = 1;
    if (failure === 'malformed') state.linearBody = { data: { viewer: { assignedIssues: { nodes: [] } } } };
    if (failure === 'write') state.writeFail = true;
    if (failure === 'invalid-date') state.issues[0].dueDate = 'invalid';
    assert.throws(() => api.syncLinearToGoogleCalendar());
    assert.deepEqual(state.writes, []);
    assert.equal(state.events.length, 2);
    assert.equal(state.releases, 2);
  });
}

test('カレンダーでの日付・通知・繰り返し編集をLinearの終日予定へ戻す', () => {
  const { api, state } = harness();
  api.syncLinearToGoogleCalendar();
  Object.assign(state.events[0], {
    start: { dateTime: '2026-09-11T10:00:00+09:00' },
    end: { dateTime: '2026-09-11T11:00:00+09:00' },
    recurrence: ['RRULE:FREQ=DAILY'], reminders: { useDefault: true }, transparency: 'opaque',
  });
  api.syncLinearToGoogleCalendar();
  assert.equal(state.events[0].start.date, '2026-09-10');
  assert.equal(state.events[0].start.dateTime, null);
  assert.equal(state.events[0].recurrence, null);
  assert.equal(state.events[0].reminders.useDefault, false);
});

test('セットアップはカレンダーを一度だけ作り、旧新の同期トリガーを6件に揃える', () => {
  const { api, state } = harness();
  delete state.properties.GOOGLE_CALENDAR_ID;
  state.triggers = ['syncLinearToGoogleTasks', 'syncLinearToGoogleCalendar', 'unrelated']
    .map((handler) => ({ handler, getHandlerFunction: () => handler }));
  api.setupSync();
  api.setupSync();
  assert.equal(state.calendarCreates, 1);
  assert.equal(state.properties.GOOGLE_CALENDAR_ID, 'created-calendar');
  assert.equal(state.events.length, 1);
  assert.equal(state.triggers.length, 7);
  assert.equal(state.triggers[0].handler, 'unrelated');
  assert.deepEqual(state.triggers.slice(1).map((trigger) => [trigger.handler, trigger.hour, trigger.zone]),
    [6, 9, 12, 15, 18, 21].map((hour) => ['syncLinearToGoogleCalendar', hour, 'Asia/Tokyo']));
  api.resetSyncTriggers();
  assert.equal(state.triggers.length, 7);
  api.removeSyncTriggers();
  assert.equal(state.triggers.length, 1);
});

for (const previousSchedule of [undefined, 'Asia/Tokyo:7,12,18', 'UTC:6,9,12,15,18,21']) {
  test(`次の同期で未記録・時刻・タイムゾーン変更を反映し、再同期では作り直さない: ${previousSchedule}`, () => {
    const { api, state } = harness();
    state.userProperties.SYNC_TRIGGER_SCHEDULE = previousSchedule;
    state.triggers = ['unrelated', 'syncLinearToGoogleCalendar', 'syncLinearToGoogleTasks']
      .map((handler) => ({ handler, getHandlerFunction: () => handler }));
    const unrelated = state.triggers[0];
    api.syncLinearToGoogleCalendar();
    assert.equal(state.triggers[0], unrelated);
    assert.deepEqual(state.triggers.slice(1).map((trigger) => [trigger.handler, trigger.hour, trigger.zone]),
      [6, 9, 12, 15, 18, 21].map((hour) => ['syncLinearToGoogleCalendar', hour, 'Asia/Tokyo']));
    const installed = [...state.triggers];
    api.syncLinearToGoogleCalendar();
    assert.deepEqual(state.triggers, installed);
    assert.equal(state.triggerCreates, 6);
  });
}

test('停止後に手動同期してもトリガーを復活させない', () => {
  const { api, state } = harness();
  api.resetSyncTriggers();
  api.removeSyncTriggers();
  state.userProperties.SYNC_TRIGGER_SCHEDULE = 'Asia/Tokyo:7,12,18';
  api.syncLinearToGoogleCalendar();
  assert.equal(state.triggers.length, 0);
  assert.equal(state.triggerCreates, 6);
});

test('新トリガーの作成失敗時は旧時刻を残し、次回同期で再試行する', () => {
  const { api, state } = harness();
  state.triggers = [7, 12, 18].map((hour) => ({
    hour, getHandlerFunction: () => 'syncLinearToGoogleCalendar',
  }));
  const previous = [...state.triggers];
  state.userProperties.SYNC_TRIGGER_SCHEDULE = 'Asia/Tokyo:7,12,18';
  state.triggerCreateFailAt = 3;
  assert.throws(() => api.syncLinearToGoogleCalendar(), /Trigger creation failed/);
  assert.deepEqual(state.triggers, previous);
  assert.equal(state.userProperties.SYNC_TRIGGER_SCHEDULE, 'Asia/Tokyo:7,12,18');
  api.syncLinearToGoogleCalendar();
  assert.deepEqual(state.triggers.map((trigger) => trigger.hour), [6, 9, 12, 15, 18, 21]);
});

test('トリガーの件数が不足した場合は次回同期で修復する', () => {
  const { api, state } = harness();
  api.resetSyncTriggers();
  state.triggers.pop();
  api.syncLinearToGoogleCalendar();
  assert.deepEqual(state.triggers.map((trigger) => trigger.hour), [6, 9, 12, 15, 18, 21]);
});

test('旧トリガーの削除途中で失敗しても、次回同期で重複を整理する', () => {
  const { api, state } = harness();
  api.resetSyncTriggers();
  state.userProperties.SYNC_TRIGGER_SCHEDULE = 'Asia/Tokyo:7,12,18';
  const deleteTrigger = api.ScriptApp.deleteTrigger;
  let calls = 0;
  api.ScriptApp.deleteTrigger = (trigger) => {
    if (++calls === 2) throw new Error('Trigger deletion failed');
    deleteTrigger(trigger);
  };
  assert.throws(() => api.syncLinearToGoogleCalendar(), /Trigger deletion failed/);
  api.syncLinearToGoogleCalendar();
  assert.deepEqual(state.triggers.map((trigger) => trigger.hour), [6, 9, 12, 15, 18, 21]);
});

test('保存カレンダーが利用不能なら停止し、再作成しない', () => {
  const { api, state } = harness();
  state.calendarFail = true;
  assert.throws(() => api.setupSync(), /inaccessible/);
  assert.throws(() => api.syncLinearToGoogleCalendar(), /inaccessible/);
  assert.equal(state.calendarCreates, 0);
  assert.deepEqual(state.writes, []);
});

test('途中まで作成して失敗しても、次回同期で重複せず残りを修復', () => {
  const { api, state } = harness();
  state.issues.push(issue({ id: 'issue-2' }));
  const insert = api.Calendar.Events.insert;
  let calls = 0;
  api.Calendar.Events.insert = (...args) => {
    if (++calls === 2) throw new Error('Temporary failure');
    return insert(...args);
  };
  assert.throws(() => api.syncLinearToGoogleCalendar(), /Temporary failure/);
  assert.equal(state.events.length, 1);
  api.syncLinearToGoogleCalendar();
  assert.equal(state.events.length, 2);
  assert.equal(new Set(state.events.map((event) => event.extendedProperties.private.linearIssueId)).size, 2);
});

test('初回同期失敗後は旧同期が停止し、再セットアップで復旧する', () => {
  const { api, state } = harness();
  state.triggers = [{ getHandlerFunction: () => 'syncLinearToGoogleTasks' }];
  state.writeFail = true;
  assert.throws(() => api.setupSync());
  assert.equal(state.triggers.length, 0);
  state.writeFail = false;
  api.setupSync();
  assert.equal(state.triggers.length, 6);
  assert.equal(state.events.length, 1);
});

test('プレビューは読み取り専用、同期はロック競合時にスキップ', () => {
  const { api, state } = harness();
  api.previewLinearTasks();
  assert.equal(JSON.parse(state.logs[0])[0].actionable, true);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.eventReads, []);
  state.locked = true;
  api.syncLinearToGoogleCalendar();
  assert.throws(() => api.setupSync(), /Another sync/);
  assert.deepEqual(state.writes, []);
});

test('Linearの一時的な障害を最大3回再試行する', () => {
  const { api, state } = harness();
  state.statuses = [429, 503, 200];
  api.syncLinearToGoogleCalendar();
  assert.deepEqual(state.sleeps, [1000, 2000]);
  assert.equal(state.events.length, 1);
  state.statuses = [503, 503, 503];
  state.writes = [];
  assert.throws(() => api.syncLinearToGoogleCalendar(), /temporary error/);
  assert.deepEqual(state.writes, []);
});
