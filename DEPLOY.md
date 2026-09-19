# クラウドに公開する手順（常時・社外からアクセス）

## Macの電源オフでも使いたい場合

**自宅／会社のMacだけで動かしている限り、Macがオフ・スリープ中は誰もアクセスできません。**  
24時間つながるようにするには、次のどちらかが必要です。


| 方法           | 内容                                     |
| ------------ | -------------------------------------- |
| **クラウド（手軽）** | 下記の **Render + MongoDB Atlas**。Macは不要。 |
| **社内サーバー**   | 常時電源ONのPC／サーバーに Node を載せ、ITに常駐設定してもらう。 |


このドキュメントは **クラウド（Render + Atlas）** の手順です。

---

無料で始める構成：**Render（アプリ）** ＋ **MongoDB Atlas（データ保存）**  
※ Render の無料 Web はディスクが消えるため、データは必ず MongoDB に置きます。

---

## 1. MongoDB Atlas（無料）でデータベースを作る

1. [https://www.mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) でアカウント作成
2. **Create** で無料クラスター（M0）を作成（リージョンは近い場所で可）
3. **Database Access** でユーザー名・パスワードを作成（メモする）
4. **Network Access** → **Add IP Address** → **Allow Access from Anywhere**（`0.0.0.0/0`）を追加
  （Render などクラウドから接続するため。社内限定にしたい場合は後から IP 制限可能）
5. **Database** → **Connect** → **Drivers** → 接続文字列（URI）をコピー
  - `<password>` を実際のパスワードに置き換える  
  - 例: `mongodb+srv://user:YOURPASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

この URI 全体を `**MONGODB_URI`** として次のステップで使います。

---

## 2. GitHub にコードを push する

`dispatch-manager` フォルダをリポジトリにして GitHub に上げます（`node_modules` は上げない）。

`.gitignore` 例:

```
node_modules/
data/
.DS_Store
```

---

## 3. Render.com で Web サービスを作る

1. [https://render.com](https://render.com) でアカウント作成
2. **New** → **Web Service**
3. GitHub リポジトリを接続し、`dispatch-manager` がルートならそのまま、サブフォルダなら **Root Directory** に `dispatch-manager` を指定
4. 設定例:
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
5. **Environment** に変数を追加:
  - **Key**: `MONGODB_URI`  
  - **Value**: 手順1でコピーした URI（パスワード反映済み）
6. **Create Web Service** でデプロイ

完了後、Render が表示する URL（例: `https://dispatch-manager-xxxx.onrender.com`）をスタッフに共有します。

---

## 3b. 別工場向けに 2つ目の URL を作る（データ分離）

たとえ: 同じ受付ノートの見た目で、**別の冊子**をもう1冊用意するイメージです。URL もデータも工場ごとに分けます。

同じ GitHub リポジトリから、Render で **もう1つ Web Service** を作ります。

1. [https://dashboard.render.com](https://dashboard.render.com) を開く
2. **New** → **Web Service**
3. 既存と同じリポジトリ（例: `haisha-dispatch`）を選ぶ
4. 設定:
  - **Name**: `haisha-dispatch-ahhp`（工場ごとに変える）
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
5. **Environment** に次を追加:

| Key | Value（AHHP の例） | 意味 |
| --- | --- | --- |
| `MONGODB_URI` | 既存と同じ Atlas 接続文字列で可 | データの保管庫への接続先 |
| `MONGODB_DB` | `dispatch_app_ahhp` | **工場専用のDB名**（既存の `dispatch_app` と別にする） |
| `FACTORY_LABEL` | `AHHP` | 画面タイトルに「（AHHP）」と表示 |

6. **Create Web Service** でデプロイ

完成例 URL: `https://haisha-dispatch-ahhp.onrender.com/`

注意:

- 既存サービス側は `MONGODB_DB` を**設定しない**（または `dispatch_app`）のまま → 既存データはそのまま
- `MONGODB_DB` を工場ごとに変えれば、同じ Atlas クラスターでも依頼は混ざりません
- Discord 通知（`DISCORD_WEBHOOK_URL`）は工場用チャンネルが決まるまで未設定で問題ありません

---

## 4. 無料プランの注意（Render）

- しばらくアクセスがないとスリープし、初回アクセスが数十秒かかることがあります
- 常時即応が必要なら有料プランの検討となります

---

## 5. セキュティについて

現状、アプリにログイン機能はあります。**URL を知っている人は誰でも開けます。**  
社外に URL を広めない・推測されにくい URL のみ共有する運用を推奨します。  
ログインや Basic 認証が必要になった場合は別途対応可能です。

---

## ローカルで MongoDB を試す場合

```bash
export MONGODB_URI="mongodb+srv://..."
npm start
```

`MONGODB_URI` が無いときは従来どおり `data/db.json` に保存されます。