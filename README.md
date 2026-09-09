# Linear → Google Tasks Sync

Linear の `Life` Project にある個人タスクを Google Tasks に投影する、Google Apps Script ベースの同期ツールです。

このリポジトリでは **Linear をタスクの正本（Source of Truth）** とし、Google Tasks はスマートフォンや Google Calendar から確認するための軽量な実行ビューとして扱います。

## Architecture

```text
ChatGPT
   │
   │ タスクの作成・更新・完了
   ▼
Linear / Life Project
   │
   │ Google Apps Script による定期 reconcile
   ▼
Google Tasks / Linear list
```

- ChatGPT: 日常的な操作インターフェース
- Linear: タスク、状態、期限、背景情報の正本
- Google Tasks: 実行対象を確認するための投影先
- Google Apps Script: Linear API と Google Tasks API の同期処理

リアルタイム同期は目的とせず、定期的に Google Tasks を Linear の現在状態へ揃える **reconciliation** を採用します。

## Sync policy

### Google Tasks に表示する Issue

以下をすべて満たす Linear Issue を同期対象とします。

- Project が `Life`
- Linear の認証ユーザー本人に assign されている
- Status type が `unstarted` または `started`
  - 例: `Todo`, `In Progress`, `In Review`
- `Attention / Waiting` ラベルが付いていない

`Attention / Needs Review` は本人が確認・判断する必要があるため、同期対象に含めます。

### Google Tasks に表示しない Issue

- `Backlog`
- `Done`
- `Canceled`
- `Attention / Waiting`
- Life Project 外へ移動した Issue
- 自分の assign から外れた Issue

以前同期されていた Google Task が上記の状態になった場合、その Task は完了状態へ更新します。

## Source-of-truth rule

同期は **Linear → Google Tasks の片方向**です。

Google Tasks 側で行った変更を Linear へ戻しません。

たとえば Google Tasks 上で Task を完了しても、対応する Linear Issue が未完了であれば、次回 reconcile 時に Linear の状態が優先されます。

日常的な完了操作は、ChatGPT または Linear から行うことを想定しています。

## Schedule

`setupSync()` で、Asia/Tokyo の以下の時刻に同期するトリガーを作成します。

- 朝: 07:00 頃
- 昼: 12:00 頃
- 夕: 18:00 頃

Apps Script の time-driven trigger は厳密な cron ではないため、指定時刻の前後に実行されることがあります。この用途では分単位の厳密性は必要としません。

時刻は `コード.js` の `CONFIG.SYNC_HOURS` で指定しています。変更後は `resetSyncTriggers()` を実行すると、同期用トリガーだけを作り直せます。

## Repository structure

```text
.
├── コード.js           # Linear → Google Tasks reconcile 本体
├── appsscript.json     # Apps Script manifest
├── README.md           # セットアップ・運用説明
├── AGENTS.md           # AI / coding agent 向け編集規約
└── .clasp.json         # clasp の接続先 Script ID
```

## Requirements

- Google account
- Linear account
- Linear Personal API Key
- Google Apps Script
- Google Tasks API
- Node.js / npm（`clasp` を使う場合のみ）

## Setup

以下は新規プロジェクトを作るときの初期設定です。設定・動作確認済みの「Life KB」をローカルで編集する場合は、後述の「Local development with clasp」へ進んでください。

### 1. Apps Script project を作成

[Google Apps Script](https://script.google.com/) にアクセスし、「新しいプロジェクト」を作成して、名前を **Life KB** に変更します。

エディタの既定のコードファイルに、このリポジトリの `コード.js` の内容を貼り付けて保存します。`CONFIG.LINEAR_PROJECT_ID` が対象の Life Project の ID であることも確認してください。

左側の **プロジェクトの設定** で、`appsscript.json` マニフェスト ファイルをエディタで表示する設定を有効にし、エディタに戻って `appsscript.json` を以下の内容にして保存します。

```json
{
  "timeZone": "Asia/Tokyo",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Tasks",
        "version": "v1",
        "serviceId": "tasks"
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

### 2. Google Tasks API を有効化

Apps Script editor の **サービス → ＋** から **Google Tasks API**（バージョン `v1`、識別子 `Tasks`）を追加します。

上記のマニフェストで設定済みの場合は、サービス一覧に `Tasks` があることを確認すれば十分です。

### 3. Linear API Key を作成

Linear の Personal API Key を作成します。

この同期処理は Linear を読み取るだけなので、可能な限り **read-only / 最小権限**にしてください。

API Key をソースコードへ直接書かないでください。

### 4. Script Property を設定

Apps Script の左側の **プロジェクトの設定 → スクリプト プロパティ** で、プロパティ名を `LINEAR_API_KEY`、値を作成した Linear Personal API Key にして保存します。

```text
LINEAR_API_KEY=<Linear Personal API Key>
```

API Key は Git 管理しません。

### 5. Preview

Apps Script editor 上部の関数選択で `previewLinearTasks`（先頭は小文字）を選び、「実行」を押します。

```javascript
previewLinearTasks()
```

初回は権限の承認画面が表示されるので、利用する Google アカウントを選んで内容を確認し、承認します。承認後、必要に応じて再実行してください。

実行ログでエラーがなく、想定した Linear Issue だけが `actionable: true` になっていることを確認します。この関数は読み取り専用で、Google Tasks の更新は行いません。

### 6. Initial sync / trigger setup

関数選択を `setupSync` に切り替え、「実行」を押します。追加の権限承認が表示された場合は承認します。

```javascript
setupSync()
```

Linear の読み取り確認と初回同期のあと、07:00 / 12:00 / 18:00 頃の定期トリガーが作成されます。

完了後、以下を確認してください。

- 実行ログに `Setup complete.` が表示されている。
- Google Tasks の専用リスト `Linear` に、対象のタスクが反映されている。
- Apps Script 左側の **トリガー**（時計アイコン）に、実行する関数が `syncLinearToGoogleTasks` の時間主導型トリガーが **3件**ある。

同じアカウントで `setupSync()` を再実行すると、既存の同期用トリガーを削除して3件を作り直します。初回同期も再実行されるため、ローカルへの取り込みや通常のコード反映のたびに実行する必要はありません。

## Google Tasks representation

同期した Task は専用の Google Tasks list `Linear` に作成します。

Task には Linear Issue を識別する marker を保持し、同じ Issue から Task が重複生成されないようにします。

想定イメージ:

```text
Title:
MIH-103 ランニング用バッグを購入する

Notes:
LINEAR_ISSUE_ID:<Linear issue id>
<Linear issue URL>

Due:
<Linear dueDate>
```

実際の表現は `コード.js` の実装を正とします。

## Reconciliation behavior

同期処理は冪等に動作することを目標とします。

| Linear | Google Tasks | Action |
|---|---|---|
| actionable | なし | 作成 |
| actionable | あり・差分あり | 更新 |
| actionable | あり・差分なし | 変更なし |
| non-actionable | あり | 完了 |
| sync 対象外になった | あり | 完了 |
| 同じ Linear Issue の重複 Task | 複数 | 1件を残して余分を完了 |

同期処理中の多重実行は `LockService` で抑止します。

## Local development with clasp

Apps Script のコードを Git で管理する場合は Google 公式 CLI の `clasp` を利用できます。

```bash
npm install -g @google/clasp
clasp login
```

[Apps Script のユーザー設定](https://script.google.com/home/usersettings)で **Google Apps Script API** を有効にします。これは、同期処理が使用する Google Tasks API とは別の設定です。

既存 Apps Script project を初めて取得する場合は、取得先のフォルダで以下を実行します。スクリプトIDは Apps Script の **プロジェクトの設定 → スクリプト ID** で確認できます。

```bash
clasp clone <SCRIPT_ID>
```

このリポジトリは「Life KB」を取り込み済みです。`.clasp.json` とコードがある場合、再度 clone する必要はありません。Google側の最新コードを取得するときは `clasp pull` を使い、ローカルの未反映の編集がないことを先に確認してください。

`LINEAR_API_KEY` などのスクリプト プロパティと、作成済みのトリガーはGoogle側に保持されます。clone / pull のために設定し直す必要はありません。

ローカルから反映:

```bash
clasp push
```

Apps Script editor 側の変更を取得:

```bash
clasp pull
```

通常はローカルを編集元とし、Web editor での直接編集はデバッグや緊急修正に限定する運用を推奨します。

## Git / secrets

最低限、以下を Git に commit しないでください。

```gitignore
.clasprc.json
node_modules/
.env
.env.*
```

`LINEAR_API_KEY` は Apps Script の Script Properties に保持します。

`.clasp.json` の `scriptId` は secret ではありませんが、リポジトリを公開する場合は運用方針に応じて除外して構いません。

## Operational principles

1. Linear を唯一のタスク正本とする
2. Google Tasks は disposable な projection とみなす
3. 双方向同期を安易に追加しない
4. 同期失敗は次回 reconcile で自己修復できる設計を優先する
5. API Key や OAuth credential を repository に保存しない
6. フィルタ条件は Life Project の運用ルールと整合させる
7. 同期頻度より、予測可能で壊れにくい挙動を優先する

## Troubleshooting

### `Missing Script Property LINEAR_API_KEY`

Apps Script の Script Properties に `LINEAR_API_KEY` が設定されているか確認してください。

### `Tasks is not defined`

Apps Script の Services で Google Tasks API が有効になっているか確認してください。

### Task が作成されない

`previewLinearTasks()` を実行し、以下を確認します。

- Life Project に所属しているか
- 自分に assign されているか
- Status が actionable か
- `Waiting` ラベルが付いていないか

### Google Tasks で完了した Task が復活する

仕様です。Linear が正本なので、Linear Issue が未完了なら次回 reconcile で再び未完了状態へ揃えます。

Linear 側を `Done` にしてください。
