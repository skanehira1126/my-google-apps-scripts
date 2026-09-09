# AGENTS.md

このリポジトリは Linear の Life Project を Google カレンダーへ定期同期する Google Apps Script を管理する。レビューで発見したレポートは必ず日本語で記載する。

## Goal / System boundaries

- Linear がタスク・状態・期限・担当・Project・ラベルの正本。
- Google Calendar は期限を iPhone で見るための投影先。逆同期は追加しない。
- スクリプト プロパティが credential / 接続先 ID の保存先。Git は実装・設定・ドキュメントの編集元。
- 正本の一貫性、冪等性、障害時の修復性、シンプルさ、実行コスト、リアルタイム性の順に優先する。
- 高機能化自体を目的にしない。外部 npm dependency は明確な必要性がなければ追加しない。

## Target scope / Sync semantics

対象 Team は Mihanada、Project は Life、担当は Linear の認証ユーザー本人。Project ID は `コード.js` の `CONFIG.LINEAR_PROJECT_ID` を正とする。変更する場合は README も更新する。

同期条件は **期限あり、state type が `unstarted` または `started`**。Waiting / Needs Review ラベルは除外条件にしない。過去の期限もその日付に同期する。

- 対象でイベントなし: 作成。
- 対象で差分あり: 同じイベントを更新。
- 対象で差分なし: 変更しない。
- Backlog / Done / Canceled / 期限削除 / 担当変更 / Project外: 同期イベントを削除。
- 削除・アーカイブなどで取得対象外: 同期イベントを削除。
- 同じ Issue の重複イベント: 最新更新の1件を残し、余分を削除。

今回の承認済み設計では、対象外の**同期イベントの削除**を許容する。旧 Google Tasks は残し、更新・完了・削除しない。

## Calendar isolation / Representation

- 初回 `setupSync()` が専用カレンダー Linear を作成し、`GOOGLE_CALENDAR_ID` をスクリプト プロパティに保存する。
- 以降は ID で接続する。保存済みカレンダーにアクセスできない場合は停止し、名前検索や代替カレンダー作成で回避しない。
- イベントの `extendedProperties.private` に `syncSource=linear-life-calendar-v1` と `linearIssueId` を保存する。
- 専用カレンダー内でも両方のマーカーがあるイベントだけを変更する。他のイベントや他カレンダーには触れない。
- 対応付けは Linear 内部 Issue ID。表示用 identifier だけをキーにしない。
- タイトルは `[identifier] title`。説明に URL・状態・ラベルを記載する。
- 期限日から翌日までの日付フィールドで1日の終日イベントを作る。空き時間表示、通知なし。
- Linear からの片方向同期。カレンダー側の変更は同期管理フィールドを Linear に戻す。

## Reconciliation / Failure handling

- Linear と Calendar の対象を全ページ取得してからイベントを変更する。取得失敗や不完全な Linear 接続を空集合と見なして削除しない。
- Calendar の取得に日付窓を設けない。古い期限や変更前の日付のイベントも整理対象とする。
- 日付などの生成を全件完了してから書き込み、作成・更新成功後に削除する。
- LockService のスクリプトロックを利用し、通常同期は取得できなければスキップ。セットアップ・トリガー操作も同じロックで保護する。
- Linear の 429 / 5xx は最大3回、限定的に再試行する。無制限 retry は追加しない。
- 更新途中の失敗でも、次回同期で差分を修復できる構造を維持する。

## Public functions / Schedule

- `previewLinearTasks()`: 読み取り専用で同期対象の判定を表示する。
- `syncLinearToGoogleCalendar()`: 既存の専用カレンダーへ同期する。
- `setupSync()`: 接続確認・必要ならカレンダー作成、旧新トリガー削除、初回同期、3件のトリガー作成。
- `resetSyncTriggers()`: 同期せずトリガーだけ再設定。
- `removeSyncTriggers()`: 同期用トリガーだけ停止。

Asia/Tokyo の07:00 / 12:00 / 18:00頃。厳密な分単位の実行を前提にしない。時刻は CONFIG に集約し、変更時は README も更新する。

トリガー操作は旧 `syncLinearToGoogleTasks` と新 `syncLinearToGoogleCalendar` だけを対象とし、他の関数のトリガーを変更しない。同じアカウントの再実行で重複させない。別アカウントのトリガーを操作できない制約を移行手順に記載する。

## Security

- `LINEAR_API_KEY`、OAuth token、credential JSON、session credential をソース・README・ログ・fixture に直接記載しない。例は `<...>` の placeholder のみ。
- API Key は `PropertiesService.getScriptProperties()` から取得する。
- Linear は read-only。不要な write permission を要求しない。
- 公開関数と抽象化は少数に保ち、内部 helper は末尾 `_`、設定は CONFIG に集約する。
- コメントでは処理の理由を優先する。現代的な JavaScript と Apps Script の標準・Advanced Service を使用する。

## Testing / Documentation contract

変更時は `node --check コード.js` と `node --test tests/calendar-sync.test.cjs` を実行する。外部 API を置き換え、対象条件、日付境界、再同期の冪等性、同一イベントの更新、対象外削除、手動イベントの隔離、取得失敗時の中断、重複整理、トリガー移行を検証する。

本番の同期やトリガー操作は明示的な依頼なしに実行しない。実 API の権限承認と iPhone 表示はローカルテストでは検証できないことを報告する。

運用を変える実装では README を同時更新する。関数名、スケジュール、Script Properties、対象条件、必要な Advanced Service、移行手順をコードに一致させる。未来の機能を実装済みとして記載しない。

## Change policy / Git / clasp

- bug fix、ログ・pagination・retry 改善、今回の仕様内のリファクタリングは通常変更。
- 逆同期、リアルタイム化、他 Project への拡大、担当条件撤廃、Backlog 同期、secret storage の変更は設計変更として影響を明示する。
- Web editor で修正した場合は、ローカル編集前に `clasp pull` と差分確認を行う。編集中ファイルを上書きしない。
- `clasp push` 前に差分と新規ファイルを確認する。manifest / Script ID / credential の意図しない変更を送信しない。
- `.claspignore` でコードとマニフェストだけを送信し、テストを本番に含めない。
- 既存コードを先に読み、既知の設定値を再質問しない。要求範囲外の機能を追加しない。
- 変更後は影響範囲、検証結果、残る手動設定を簡潔に報告する。
