# Phase C3 編成掲示板の手動確認

Baseline: `fe999a2` / `feat: add atomic formation delete API`

対象: `formations.html`。バックエンド・Firebase設定・Rulesは変更しない。

## 実行環境と判定

手動ブラウザ試験はすべて **NOT RUN**。以下は外部レビュー承認後に、閉鎖したローカル環境・Firestore Emulator・API mockで実施する手順。
本番APIへのPOST/DELETE、本番Firestoreへの試験データ投入は禁止。
ローカル試験ではページを配信し、firebase-config.js相当のglobalとFirebase SDKをテスト用に差し替える。`API_BASE_URL`はmockを指し、外部ネットワークは遮断する。リポジトリ内の本番設定を上書きしない。
secretはテスト用のものだけを扱い、スクリーンショット・console・共有ログ・試験報告へ生値を転載しない。Networkで比較した結果は「一致/不一致」で記録する。

## 手動試験マトリクス

| ID | 操作・準備 | 期待結果 | 結果 |
|---|---|---|---|
| A | `?category=gw` / `multi` / `high`をそれぞれ表示。未知値も指定 | タイトル・read collection・API category・secret keyのcategoryが一致。未知値はgw | NOT RUN |
| B | 名前を固定し、新規投稿。Networkとテスト用Storageを確認 | POSTのみ。bodyはrequest_id/delete_secret/name/comment/imagesの5項目。送信前に`gbf_portal_post_secret_v1:{category}:{UUID}`へsecret保存・readback。Firestore直接writeなし | NOT RUN |
| C | 201成功を返し、snapshotを遅延後に同じIDを追加 | コメント・画像・文字数をreset。名前固定維持。「投稿済み・一覧更新待ち」から一覧反映へ移行。snapshot前にカードを追加しない | NOT RUN |
| D | 送信を受理したmockが応答を切断。同内容で再投稿し200 replayed=trueを返す | request_id/secret/payload完全一致。カード重複なし | NOT RUN |
| E | secretキーのsetItemをthrowさせる。別試験でreadbackを不一致にする | POST 0回。フォーム保持。保存設定の案内。secretを表示しない | NOT RUN |
| F | fetchをreject。503も試験 | フォーム・pending保持。成功表示なし。離脱でbeforeunload警告。reload後に自動再送しない | NOT RUN |
| G | 結果不明のまま同じフォーム内容で再投稿 | 同request_id/secret/bodyを再利用。連打してもin-flight中は1回だけ | NOT RUN |
| H | 結果不明後にname/comment/imagesを変更し再投稿。旧pendingに200を返す | 旧payloadだけを送信。新フォーム保持。新内容は未投稿と案内。次の明示クリックで新request_idを作る | NOT RUN |
| I | secretを所持するカードで削除をconfirm | DELETE + X-Delete-Secret。body/Content-Typeなし。204空body後だけカード消去。連打抑止。secretはStorageに残る | NOT RUN |
| J | 同じ一覧をStorageのない別端末で表示 | カードは表示、削除ボタンなし。favoriteは削除権限にならない | NOT RUN |
| K | legacy投稿に現在の名前・authorId・旧ID履歴を一致させる。secretは保存しない | legacy表示を維持。削除ボタンなし、DELETE未送信。管理人案内あり | NOT RUN |
| L | DELETEでnetwork reject/503/403/429を順に返す | カードを消さず固定案内。403は削除権限確認不可。再試行可能 | NOT RUN |
| M | Emulator/mockへ不正ID、script name/comment、object、quote画像、SVG、外部URL、bad base64を投入。閲覧キャッシュにも同じ値を入れる | 不正IDはskip。文字列はescaped表示。型不正はfallback。画像placeholder。script実行0、外部画像fetch 0、描画停止なし | NOT RUN |
| N | legacyの単体imageに正しいJPEG/PNG/WebP/GIF data URLを設定 | 4形式を表示。Base64 decode/canonical化・magic検証。不正画像はsrcへ設定しない | NOT RUN |
| O | お気に入り追加・解除・favorites filter。Storageをobjectや壊れたJSONにする | 正常なID配列のみ利用。描画crashなし。操作維持 | NOT RUN |
| P | 正常画像をクリック/Enter、modalを閉じる、Escape | modal表示・閉じる・body scroll lock維持。不正srcで開かない | NOT RUN |
| Q | 0～4画像の選択・削除・全消去・drag/drop・preview | 750px/品質0.72の既存JPEG圧縮、最大4枚、grid・badge・番号を維持。1枚200000/合計800000/JSON850000 bytes超過は送信せず画像削減案内 | NOT RUN |
| R | 名前の登録・reloadで固定・変更。絵文字30 code pointsと31を試す | 名前固定UI維持。30まで受理、31拒否。名前は所有判定に使わない | NOT RUN |
| S | SDKのset/add/update/deleteを呼ぶと失敗するmockで投稿/削除。onSnapshotは動作させる | read継続。browser formation write/delete 0。API失敗やdb未初期化でローカル投稿成功へfallbackしない | NOT RUN |
| T | onSnapshot更新、FCM foreground受信、通知トグル操作 | onSnapshotからOS通知なし。既存foreground toast/通知購読を維持 | NOT RUN |

## 追加の防御確認

| 操作 | 期待結果 | 結果 |
|---|---|---|
| POST 413/422/409/410 | フォームとsecret保持。成功扱いなし。送信済みpending解除（次回は新IDで作成） | NOT RUN |
| POST 429/503/その他非2xx、202、壊れたJSON、id/category不一致、timestamp/replayed型不正 | フォームとsecret保持。成功扱いなし。送信済みpending保持（同内容で再試行） | NOT RUN |
| secretを持った投稿で204を2回返す | 2回とも成功。secretの再発行や名前による救済なし | NOT RUN |
| API_BASE_URLを未設定、Firebase read DBを未初期化 | API_BASE_URLなしでは投稿不可を表示。DBなしでもAPI以外の作成経路なし | NOT RUN |
| name 1/30、comment 0/3000のUnicode code points、制御文字 | 境界受理。nameの制御文字禁止、commentはLF/TABだけ許可 | NOT RUN |
| remote doc.idとdoc.data().idを不一致にする。末尾改行ID、末尾改行data URLも投入 | doc.id優先。不正IDはskip、画像はplaceholder | NOT RUN |

## この実装作業中の確認

- Node.js VM + fake DOM / Storage / fetchによる49項目: PASS（外部ネットワーク0）。カテゴリ、UUID、secret保存/readback、同内容retry、編集後の旧payload確認、HTTPエラー/契約不正時の保持、DELETE失敗/成功、cache/画像入力防御を確認。
- 末尾改行・行区切りを含むID/画像URLの追加4項目: PASS。合計53 assertions。
- snapshotによる表示更新が別の未確認投稿・編集中フォームの案内を上書きしない追加3項目: PASS。総計56 assertions。
- 外部レビュー修正 #1のNode.js VM + Map Storage / fetch検証47項目: PASS（外部ネットワーク0）。POST fetch到達、413/422/409/410でpending解除、429/503/network reject/壊れた200・201でpending保持、確定失敗後の次回明示クリックで新request_id・新delete_secret・現在フォームpayloadを使用し、旧secretを保持することを確認。
- 既存backend 5ファイル回帰: 188 passed, 25 warnings。既存24件に加え、書込み制限下で`.pytest_cache`を作成できない警告1件。既存テストとbackendは変更なし。
- これは実ブラウザの表示品質・画像decode・Storage制限・実SDK・実API・Firestore Emulatorの結合試験を代替しない。上表の手動試験をPASSへ読み替えない。
- backend 5ファイル回帰・静的監査の最終結果は作業完了報告に記載。

## 再送と残る制約

未確認payloadはページmemoryだけに残る。reload後はpayloadを復元・自動送信せず、保存済みsecretでsnapshotの削除ボタンだけを復元する。
非2xxではsecretを削除しない。413/422/409/410などの場合は旧pendingを解除し、次回の明示クリックで新しいrequest_idを生成する。429/503などは旧pendingを保持し、再試行させる。
閲覧キャッシュの書込み失敗時はmemory上のsnapshotを表示する。画像data URLの表示上限は1500000文字（Firestoreの文書上限を超える異常cache値への防御）。
Rules閉鎖と本番接続確認は後続Phase。C3だけでは直接書込み可能な既存Rulesの問題は解消しない。
