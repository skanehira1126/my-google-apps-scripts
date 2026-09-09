# Linear → Google Calendar Sync

Linear の `Life` Project にある、**期限付き・未完了の自分のタスク**を、専用の Google カレンダー `Linear` に終日イベントとして同期する Google Apps Script です。iPhone 標準のカレンダーアプリから期限を確認できます。

Linear をタスクの正本とし、タイトル・状態・期限・担当の変更は Linear で行います。Google カレンダーから Linear への逆同期はありません。

- 新規導入: [Setup](#setup)
- 既存の Life KB を変更: [Google Tasks版からの移行](#google-tasks版からの移行)
- iPhoneで表示: [iPhoneでの表示](#iphoneでの表示)
- 編集・検証: [Local development with clasp](#local-development-with-clasp)
- エラー対応: [Troubleshooting](#troubleshooting)

## Architecture

```text
Linear / Life Project（正本）
    ↓ Google Apps Scriptで定期同期
Google Calendar / Linear（期限当日の終日イベント）
    ↓ Googleアカウントのカレンダー同期
iPhone カレンダー
```

## Sync policy

対象は `コード.js` の `CONFIG.LINEAR_PROJECT_ID` に指定した Life Project（`4eaf63bf-9834-40ff-8358-e2407127b975`）で、Linear API Key の認証ユーザー本人が担当する Issue です。

| Linear の条件 | カレンダーでの動作 |
|---|---|
| 期限あり、state type が `unstarted` または `started` | 期限当日に作成・必要な差分だけ更新 |
| Waiting / Needs Review ラベルあり | 上記条件を満たせば同期 |
| Backlog | 登録しない。同期済みイベントは削除 |
| Done / Canceled | 同期済みイベントを削除 |
| 期限削除・担当変更・Life Project外への移動 | 同期済みイベントを削除 |
| 削除・アーカイブなどで取得対象外 | 同期済みイベントを削除 |

過去の期限も、その日付のまま登録します。Google Tasks 版では除外していた **Waiting も同期対象**です。

### イベントの表示と識別

- タイトル: `[MIH-123] タイトル`
- 説明: Linear Issue へのリンク、状態、ラベル
- 日付: 期限当日の1日だけの終日イベント
- 予定の表示: 空き時間（他の予定を塞がない）
- 通知: なし

終日イベントの終了日は API 上では翌日を指定します。時刻への変換による日付ずれを避け、日付のまま扱います。([Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference/events))

専用カレンダー内でも、非公開拡張プロパティの `syncSource=linear-life-calendar-v1` と `linearIssueId` があるイベントだけを更新・削除します。手動作成イベントや別の同期元のイベントには触れません。([拡張プロパティ](https://developers.google.com/workspace/calendar/api/guides/extended-properties))

同じ Issue のイベントが複数ある場合は更新日時が新しい1件を残し、余分を削除します。カレンダー側でタイトルや日付などを変更しても、次回同期で Linear に合わせます。カレンダー側で削除した場合も、対象の Issue が残っていれば再作成します。

## Schedule

Asia/Tokyo の **07:00 / 12:00 / 18:00 頃**に同期します。Apps Script の時間主導型トリガーのため、厳密な時刻は保証されません。

時刻は `CONFIG.SYNC_HOURS` に集約しています。変更後に `resetSyncTriggers()` を実行すると、同期用トリガーだけを作り直せます。停止する場合は `removeSyncTriggers()` を実行します。

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

実行ログで、期限付きの未着手・進行中タスクが `actionable: true`、Backlog・Done・Canceled・期限なしが `false` になることを確認します。Waiting ラベルだけでは `false` になりません。

この関数は読み取り専用です。カレンダーの作成やイベントの更新は行いません。

### 5. 初回同期とトリガー作成

関数を **`setupSync`** に切り替えて実行します。追加の権限承認が出た場合は承認します。

Linear を読み取り、専用カレンダーの作成または接続確認を行い、同期用の既存トリガーを削除して初回同期を実行します。成功後に新しいトリガーを3件作成します。

完了後は次を確認します。

- ログに `Setup complete.` が表示されている。
- Google カレンダーに `Linear` があり、期限当日の終日イベントが表示される。
- 左側の **トリガー**（時計アイコン）に `syncLinearToGoogleCalendar` が3件ある。
- スクリプト プロパティに `GOOGLE_CALENDAR_ID` が保存されている。

同じアカウントで再実行しても、保存済みカレンダーを再利用し、同期用トリガーを3件に揃えます。通常のコード反映のたびに実行する必要はありません。

## Google Tasks版からの移行

既存の Google Tasks とリストは残します。移行処理で完了・削除しません。**旧トリガーを作成した Google アカウントで移行してください**。別アカウントのトリガーは削除できないため、複数アカウントで設定していた場合は各作成者が旧トリガーを削除します。

1. 現行コードの控えを保存し、エディタで旧版の `removeSyncTriggers()` を実行して定期同期を停止します。実行中の同期がある場合は終了を待ちます。
2. 新しい `コード.js` と `appsscript.json` を反映します。ローカルからは差分を確認後に `clasp push` を実行します。
3. サービスが `Tasks` から `Calendar`（v3）へ切り替わっていることを確認します。既存の `LINEAR_API_KEY` はそのまま使います。
4. `previewLinearTasks()` を実行し、Calendar のアクセス権限を再承認して同期対象を確認します。
5. `setupSync()` を実行します。旧 `syncLinearToGoogleTasks` と新 `syncLinearToGoogleCalendar` の既存トリガーを整理し、初回同期後に新しいものを3件作成します。
6. Calendar のイベントと新トリガー3件を確認し、以下の手順で iPhone に表示します。

本リポジトリのローカルテストは本番の同期を実行しません。移行は上記手順を実施した時点で反映されます。

## iPhoneでの表示

1. iPhone の **設定 → アプリ → カレンダー → カレンダーアカウント** を開きます（iOS により項目名は異なります）。
2. Life KB で使う Google アカウントを追加するか、既存アカウントの **カレンダー** を有効にします。
3. 標準のカレンダーアプリを開き、画面下の **カレンダー** から Google アカウント配下の **Linear** にチェックを入れます。
4. 同期を待ち、Linear で指定した期限日に終日イベントが表示されることを確認します。

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

`.claspignore` は `コード.js` と `appsscript.json` だけをアップロード対象にします。テストやドキュメントは送信しません。スクリプト プロパティとトリガーは Google 側に残り、clone / pull / push で設定し直す必要はありません。ただし今回の Tasks 版からの移行では再セットアップが必要です。

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
