# Linear → Google Calendar Sync

Linear の `Life` Project にある、**期限付き・未完了の自分のタスク**を、専用の Google カレンダー `Linear` に終日イベントとして同期する Google Apps Script です。通常は期限当日、`Calendar Range` ラベル付きで着手済みのタスクは In Progress になった日から期限日まで表示し、iPhone 標準のカレンダーアプリから確認できます。

Linear をタスクの正本とし、タイトル・状態・期限・担当の変更は Linear で行います。Google カレンダーから Linear への逆同期はありません。

- 新規導入: [Setup](#setup)
- 既存の Life KB を変更: [Google Tasks版からの移行](#google-tasks版からの移行)
- iPhoneで表示: [iPhoneでの表示](#iphoneでの表示)
- 編集・検証: [Local development with clasp](#local-development-with-clasp)
- mainへのマージで自動反映: [GitHub Actions](#github-actions)
- エラー対応: [Troubleshooting](#troubleshooting)

## Architecture

```text
Linear / Life Project（正本）
    ↓ Google Apps Scriptで定期同期
Google Calendar / Linear（期限当日または作業可能期間の終日イベント）
    ↓ Googleアカウントのカレンダー同期
iPhone カレンダー
```

## Sync policy

対象は `コード.js` の `CONFIG.LINEAR_PROJECT_ID` に指定した Life Project（`4eaf63bf-9834-40ff-8358-e2407127b975`）で、Linear API Key の認証ユーザー本人が担当する Issue です。

| Linear の条件 | カレンダーでの動作 |
|---|---|
| 期限あり、state type が `unstarted` または `started` | 期限当日に作成・必要な差分だけ更新 |
| 上記かつ `Calendar Range` ラベルあり | In Progress 開始日から期限日までの複数日終日イベント。未着手なら期限当日の単日イベント |
| Waiting / Needs Review ラベルあり | 上記条件を満たせば同期 |
| Backlog | 登録しない。同期済みイベントは削除 |
| Done / Canceled | 同期済みイベントを削除 |
| 期限削除・担当変更・Life Project外への移動 | 同期済みイベントを削除 |
| 削除・アーカイブなどで取得対象外 | 同期済みイベントを削除 |

過去の期限も、その日付のまま登録します。Google Tasks 版では除外していた **Waiting も同期対象**です。

### イベントの表示と識別

- タイトル: `[MIH-123] タイトル`
- 説明: Linear Issue へのリンク、状態、ラベル
- 日付: 通常は期限当日の1日だけ。`Calendar Range` ラベル付きで着手済みなら In Progress になった日から期限日までの複数日終日イベント
- 予定の表示: 空き時間（他の予定を塞がない）
- 通知: なし

終日イベントの終了日は API 上では翌日を指定します。Linear の状態日時は `Asia/Tokyo` の日付へ変換し、それ以外は時刻へ変換せず日付のまま扱います。`Calendar Range` の開始日が期限より後なら、期限当日の単日予定にします。([Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference/events))

専用カレンダー内でも、非公開拡張プロパティの `syncSource=linear-life-calendar-v1` と `linearIssueId` があるイベントだけを更新・削除します。手動作成イベントや別の同期元のイベントには触れません。([拡張プロパティ](https://developers.google.com/workspace/calendar/api/guides/extended-properties))

同じ Issue のイベントが複数ある場合は更新日時が新しい1件を残し、余分を削除します。カレンダー側でタイトルや日付などを変更しても、次回同期で Linear に合わせます。カレンダー側で削除した場合も、対象の Issue が残っていれば再作成します。

## Schedule

Asia/Tokyo の **06:00 / 09:00 / 12:00 / 15:00 / 18:00 / 21:00 頃**に、約3時間おき・1日6回同期します。Apps Script の時間主導型トリガーのため、厳密な時刻は保証されません。

時刻は `CONFIG.SYNC_HOURS` に集約しています。コード反映後、既存の定期同期が次に成功すると時刻・タイムゾーンの変更を検知し、同期用トリガーだけを新しい時刻の6件に作り直します。初回の変更検知も、その時点で登録されている旧時刻のトリガーを待ちます。直ちに切り替える場合は、既存トリガーを作成したアカウントで `resetSyncTriggers()` を実行します。

停止する場合は `removeSyncTriggers()` を実行します。停止中・未セットアップで同期用トリガーがない場合、コード反映や手動同期では自動復活しません。新しいトリガーの作成に失敗した場合は作成途中のものを削除して旧トリガーを残し、次回同期で再試行します。

反映済みの時刻はユーザー プロパティ `SYNC_TRIGGER_SCHEDULE` に自動記録します。アカウントごとの管理情報で、手動設定は不要です。別アカウントのトリガーは変更できません。

## Setup

### 1. Life KB を作成してコードを保存

[Google Apps Script](https://script.google.com/) で「新しいプロジェクト」を作成し、名前を **Life KB** に変更します。既定のコードファイルに、このリポジトリの `コード.js` を貼り付けて保存します。

**プロジェクトの設定** でマニフェストファイルの表示を有効にし、エディタの `appsscript.json` をリポジトリの内容と同じにします。

```json
{
  "timeZone": "Asia/Tokyo",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Calendar",
        "version": "v3",
        "serviceId": "calendar"
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

### 2. Google Calendar API を有効化

エディタの **サービス → ＋** から **Google Calendar API**（`v3`、識別子 `Calendar`）を追加します。上記マニフェストで設定済みなら、サービス一覧に `Calendar` があることを確認します。

標準の Google Cloud プロジェクトを自分で関連付けている場合は、その Cloud プロジェクトでも Google Calendar API を有効にします。([Advanced Calendar Service](https://developers.google.com/apps-script/advanced/calendar))

### 3. Linear API Key を保存

Linear Personal API Key は、対象の Life Project を読める **read-only** の権限で作成します。

Apps Script の **プロジェクトの設定 → スクリプト プロパティ** で、次を保存します。

| プロパティ | 値・用途 |
|---|---|
| `LINEAR_API_KEY` | Linear Personal API Key。ソースコードや Git に保存しない |
| `GOOGLE_CALENDAR_ID` | 初回 `setupSync()` が作成した専用カレンダーの ID を自動保存。手動入力は不要 |

保存済みの `GOOGLE_CALENDAR_ID` にアクセスできないときは停止します。同名の別カレンダーへ切り替えたり、自動で代替カレンダーを作ったりしません。

### 4. プレビューと初回承認

エディタ上部の関数選択で **`previewLinearTasks`**（先頭は小文字）を選び、「実行」を押します。Google アカウントを選んで要求された権限を確認・承認し、必要なら再実行します。

実行ログで、期限付きの未着手・進行中タスクが `actionable: true`、Backlog・Done・Canceled・期限なしが `false` になることを確認します。`calendarStartDate` には実際にカレンダーへ投影する開始日が表示されます。Waiting ラベルだけでは `false` になりません。

複数日の帯で表示したいIssueには、Linearで `Calendar Range` ラベルを作成して付与します。ラベルを外すと、次回同期で同じイベントが期限当日の単日予定へ戻ります。

この関数は読み取り専用です。カレンダーの作成やイベントの更新は行いません。

### 5. 初回同期とトリガー作成

関数を **`setupSync`** に切り替えて実行します。追加の権限承認が出た場合は承認します。

Linear を読み取り、専用カレンダーの作成または接続確認を行い、同期用の既存トリガーを削除して初回同期を実行します。成功後に新しいトリガーを6件作成します。

完了後は次を確認します。

- ログに `Setup complete.` が表示されている。
- Google カレンダーに `Linear` があり、通常タスクは期限当日、`Calendar Range` 付きの着手済みタスクは In Progress 開始日から期限日まで表示される。
- 左側の **トリガー**（時計アイコン）に `syncLinearToGoogleCalendar` が6件ある。
- スクリプト プロパティに `GOOGLE_CALENDAR_ID` が保存されている。

同じアカウントで再実行しても、保存済みカレンダーを再利用し、同期用トリガーを6件に揃えます。通常のコード反映のたびに実行する必要はありません。

## Google Tasks版からの移行

既存の Google Tasks とリストは残します。移行処理で完了・削除しません。**旧トリガーを作成した Google アカウントで移行してください**。別アカウントのトリガーは削除できないため、複数アカウントで設定していた場合は各作成者が旧トリガーを削除します。

1. 現行コードの控えを保存し、エディタで旧版の `removeSyncTriggers()` を実行して定期同期を停止します。実行中の同期がある場合は終了を待ちます。
2. 新しい `コード.js` と `appsscript.json` を反映します。ローカルからは差分を確認後に `clasp push` を実行します。
3. サービスが `Tasks` から `Calendar`（v3）へ切り替わっていることを確認します。既存の `LINEAR_API_KEY` はそのまま使います。
4. `previewLinearTasks()` を実行し、Calendar のアクセス権限を再承認して同期対象を確認します。
5. `setupSync()` を実行します。旧 `syncLinearToGoogleTasks` と新 `syncLinearToGoogleCalendar` の既存トリガーを整理し、初回同期後に新しいものを6件作成します。
6. Calendar のイベントと新トリガー6件を確認し、以下の手順で iPhone に表示します。

本リポジトリのローカルテストは本番の同期を実行しません。移行は上記手順を実施した時点で反映されます。

## iPhoneでの表示

1. iPhone の **設定 → アプリ → カレンダー → カレンダーアカウント** を開きます（iOS により項目名は異なります）。
2. Life KB で使う Google アカウントを追加するか、既存アカウントの **カレンダー** を有効にします。
3. 標準のカレンダーアプリを開き、画面下の **カレンダー** から Google アカウント配下の **Linear** にチェックを入れます。
4. 同期を待ち、通常タスクはLinearで指定した期限日、`Calendar Range` 付きの着手済みタスクはIn Progress開始日から期限日まで終日イベントが表示されることを確認します。

反映には Google と iPhone 間の同期時間もかかります。([Googleの設定手順](https://support.google.com/calendar/answer/99358?co=GENIE.Platform%3DiOS&hl=ja))

## Local development with clasp

Node.js と npm が必要です。初回だけ以下を実行します。

```sh
npm install -g @google/clasp
clasp login
```

[Apps Script のユーザー設定](https://script.google.com/home/usersettings)で Google Apps Script API を有効にします。これは Google Calendar API とは別の設定です。

新しい取得先のフォルダで、プロジェクトの設定にあるスクリプト ID を使って取り込みます。

```sh
clasp clone <SCRIPT_ID>
```

このリポジトリの `.clasp.json` がある場合は取り込み済みです。Web エディタの修正を取得するときは、ローカルの未反映の編集を保存してから `clasp pull` を実行してください。編集中のコードが上書きされます。

ローカル検証:

```sh
node --check コード.js
node --test tests/calendar-sync.test.cjs
clasp show-file-status
```

外部 API を置き換えたテストで、対象条件、日付境界、冪等性、削除の隔離、障害時の中断、トリガー移行を検証します。実際の Google API 権限や iPhone 表示は、移行時に別途確認します。

反映前に `git diff`（新規ファイルは内容も）とマニフェスト・接続先を確認し、次を実行します。

```sh
clasp push
```

`.claspignore` は `コード.js` と `appsscript.json` だけをアップロード対象にします。テストやドキュメントは送信しません。スクリプト プロパティとトリガーは Google 側に残ります。同期時刻を変更した場合は次の定期同期成功時に自動再設定されます。Tasks 版からの移行では `setupSync()` を実行します。

## GitHub Actions

`.github/workflows/apps-script.yml` が以下を実行します。

- main向けPR: 構文チェックとローカルテスト。Googleの認証情報は使用しません。
- mainへのpush（PRのマージを含む）: 同じチェックの成功後、`clasp push --force` で既存のApps Scriptへコードとマニフェストを反映します。
- 手動再実行: Actionsの **Apps Script → Run workflow** でmainを選択します。main以外からの実行ではテストのみ行います。

反映先は `.clasp.json` の Script IDです。Node.js 24とclasp 3.4.1を使用し、アップロード対象は `.claspignore` で制限します。本番へのpushは直列に実行し、待機中にmainが更新された古いコミットは反映せず、新しいコミットの実行に任せます。

### 初回の認証設定

1. 対象Apps Scriptを編集できるGoogleアカウントで `clasp login` し、Apps Script APIを有効にします。
2. リポジトリの **Settings → Secrets and variables → Actions** に、Repository secret **`CLASPRC_JSON`** を登録します。値はclaspの認証JSONです。複数アカウントを保存している場合は対象の `default` アカウントだけを含めます。
3. ワークフローをmainへマージし、Actionsで `test` と `deploy` の成功を確認します。

CLIから登録する場合は、対象アカウントだけの認証JSONを含むファイルを標準入力で渡します。認証情報をチャットやGit、コマンド引数へ貼り付けないでください。

```sh
gh secret set CLASPRC_JSON --repo skanehira1126/my-google-apps-scripts < <CLASP_AUTH_FILE>
```

認証JSONの `tokens.default` には `client_id`、`client_secret`、`type`、`refresh_token` を含めます。`access_token` と `id_token` は不要です。ワークフローはsecretを一時ファイルに復元して認証し、処理終了時に削除します。`LINEAR_API_KEY` と `GOOGLE_CALENDAR_ID` は引き続きApps Scriptのスクリプト プロパティに保存し、GitHubへ移しません。

このOAuth認証はGoogleアカウントのApps Scriptへのアクセス権を持つため、GitHub Actionsのsecretとして管理します。失効した場合は再ログインしてsecretを更新し、mainのワークフローを再実行します。Googleの[claspによるCI/CD手順](https://developers.google.com/apps-script/guides/clasp#ci/cd_for_apps_script_with_clasp_and_github_actions)も参照してください。

### 反映のタイミングと運用

マージ後はGitHubのmainを編集元にします。Apps Scriptエディタ側の変更は次の自動反映で上書きされるため、必要な変更は先にローカルへ取り込んでPRに含めます。自動反映は関数を実行しません。カレンダーの内容と同期時刻は次の定期同期成功時に反映されます。初回の `setupSync()`、停止中からの再開、新しいGoogle権限の承認はApps Scriptエディタで行います。

Apps Script APIには[トリガーを作成できない制約](https://developers.google.com/apps-script/api/how-tos/execute#limitations)があるため、GitHub Actionsから `clasp run resetSyncTriggers` は実行しません。実APIの権限とiPhone表示はローカルテストでは検証できません。

## Git / secrets

`.clasprc.json`、`.env`、OAuth credential、API Key は Git に保存しません。`.clasp.json` の Script ID は認証情報ではありません。API Key はスクリプト プロパティだけに保存します。

## Troubleshooting

| 症状 | 確認・対応 |
|---|---|
| `Missing Script Property LINEAR_API_KEY` | スクリプト プロパティ名と保存を確認 |
| `Calendar is not defined` | Advanced Service の Calendar v3 を有効化 |
| `Missing GOOGLE_CALENDAR_ID` | 初回 `setupSync()` を実行 |
| 保存カレンダーに接続できない | ID と実行アカウントの権限を確認。ID を消して再作成すると旧イベントが残るため、まず接続を復旧 |
| 初回同期の途中で失敗 | 原因を解消して `setupSync()` を再実行。トリガー削除後の失敗では定期同期が停止したままになる |
| タスクが表示されない | `previewLinearTasks()` で期限・状態・Project・担当を確認 |
| Googleには見えるがiPhoneに見えない | 同じ Google アカウントのカレンダー同期と `Linear` の表示選択を確認 |
| 通常同期が途中で失敗 | Apps Script の「実行数」でエラーを確認。原因解消後、次回同期または `syncLinearToGoogleCalendar()` で再試行 |

全ページの取得が失敗・不完全な場合はイベントを変更しません。更新途中の API 障害は次回同期で差分を修復します。多重実行時はスクリプトロックで通常同期をスキップし、セットアップ・トリガー操作は再実行を求めるエラーにします。
