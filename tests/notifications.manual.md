# Phase A2 通知購読 手動テスト

## 前提

- `PORTAL_WRITE_ENABLED=true` の隔離した試験環境を使う。本番Rulesが未閉鎖の環境へ実tokenを書かない。
- 試験ページは許可Origin、または `PORTAL_ALLOW_LOCAL_ORIGINS=true` のlocalhostから開く。
- DevToolsのApplicationでService Worker、Notification権限、localStorageを確認できる状態にする。
- localStorageキーは次の2個だけを通知設定に使う。
  - `gbf_portal_notification_installation_v1`
  - `gbf_portal_notification_intent_v1`
- token文字列がlocalStorage、URL、画面、consoleへ出ないことを各試験で確認する。

## 1. 権限だけではONにしない

1. 通知権限を許可済みにする。
2. 上記2キーを削除して `formations.html` を再読込する。

期待結果：ボタンはOFFで「新着プッシュ通知をONにする」。`getToken`、status、subscribeは呼ばれない。

## 2. ON成功

1. OFFボタンを1回押し、権限要求を許可する。
2. Networkでstatusの後にsubscribeが呼ばれることを確認する。
3. subscribeのrequest bodyにUUIDv4、token、statusで返ったrevisionが入ることを確認する。

期待結果：処理中はボタンが無効、`aria-busy=true`。subscribe 200後だけ `aria-pressed=true` になり「新着通知を受信します」と表示する。成功を知らせるOS通知は表示しない。

## 3. Service Worker登録失敗

1. DevToolsで `firebase-messaging-sw.js` の取得を失敗させる。
2. OFFからONを押す。

期待結果：掲示板の表示、投稿、Firestore一覧は継続する。ONにはならず「通知登録を確認できません。再試行してください」。intentは `desired=true,pending=true`。

## 4. subscribe失敗

1. subscribeを503またはネットワークエラーにする。
2. OFFからONを押す。

期待結果：ON表示にせず「通知登録を確認できません。再試行してください」。intentのpendingはtrueのまま。onlineまたはvisibleで再試行できる。

## 5. OFF成功とtoken不要

1. ON成功後、`messaging.getToken`を失敗させるか呼べない状態にする。
2. ONボタンを押す。

期待結果：getTokenを呼ばず、installation_idだけでunsubscribeする。200後に `desired=false,pending=false`、ボタンOFF。installation_idは残る。`deleteToken`失敗時もサーバーOFFと画面OFFを維持する。

## 6. unsubscribe失敗

1. ON成功後、unsubscribeを503またはネットワークエラーにする。
2. ONボタンを押す。

期待結果：先に `desired=false,pending=true` が保存される。「解除待ちです。通信復旧まで通知が届く場合があります」と表示し、OFF完了表示にしない。onlineまたはvisibleでunsubscribeを再送する。

## 7. localStorage拒否

1. localStorageのsetItemが例外になる環境またはDevTools stubを使う。
2. ONを押す。

期待結果：「端末設定を保存できないため通知登録できません」。getToken、status、subscribeへ進まない。

## 8. tokenローテーション

1. ON成功時のtokenを記録せず、Networkの呼出回数だけ確認する。
2. 同じinstallation_idのまま `messaging.getToken`が別tokenを返すstubへ切り替える。
3. 60秒経過後にページを非表示から表示へ戻す。

期待結果：status後に同じinstallation_idでsubscribeし、Firestore文書は増えず同じhash IDのtokenとrevisionが更新される。

## 9. 再読込と24時間更新

1. ON成功後に再読込する。
2. 権限がgrantedで、保存intentが `desired=true` の状態を確認する。
3. `last_synced_at`を24時間より前へ変更し、60秒経過後にvisibleイベントを発生させる。

期待結果：再読込時にgetTokenとサーバー同期を行う。24時間超ではtokenが同じでもsubscribeする。同一表示セッションの自動同期は60秒に1回を超えない。

## 10. 別タブからOFF

1. 同じOriginでformationsを2タブ開き、ONにする。
2. 片方のタブでOFFにする。

期待結果：もう片方はstorageイベントを受けてON再試行を止め、unsubscribeまたはサーバーOFF確認へ進む。遅れて完了したON処理でON表示へ戻らない。

## 11. ON処理中のOFF

1. subscribe応答を遅延させる。
2. ON処理の途中で別タブからOFFにする。
3. 遅延subscribeを完了させる。

期待結果：operation_id不一致のON結果を画面へ反映しない。unsubscribe後の最終状態はOFF。古いrevisionのsubscribeは409になり、OFF後にONを再試行しない。

## 12. 権限を外部でdeniedへ変更

1. ON成功後、ブラウザ設定で通知権限を拒否へ変更する。
2. 60秒経過後にページをforegroundへ戻す。

期待結果：`desired=false,pending=true` を保存し、getTokenなしでunsubscribeする。成功後はOFF。

## 13. 非対応ブラウザ

1. NotificationまたはFCM非対応環境で掲示板を開く。

期待結果：通知ボタンはUNSUPPORTEDで操作不可。掲示板の閲覧・投稿は継続する。保存済みのpending OFFがある場合はNotification/FCM判定より先にunsubscribeを実行する。

## 14. 409、429、タイムアウト

1. 最初のsubscribeへ409 REVISION_CONFLICTを返し、status再取得後の2回目を200にする。
2. 429とRetry-Afterを返す。
3. subscribeとunsubscribeをそれぞれ15秒より長く遅延させる。

期待結果：409は同じON operationの時だけ1回再試行する。429後はRetry-After経過まで自動再送しない。subscribeタイムアウトはstatusと再subscribeで照合し、確認できなければONにしない。unsubscribeタイムアウトはstatusでOFFを確認できた時だけOFF完了にする。

## 15. index旧処理撤去と直接書込みゼロ

次を実行する。

```text
rg -n "notification_tokens|toggleNotificationPermission|updateNotificationButtonUI|showLocalNotification|messaging\.getToken" index.html
rg -n "collection\(['\"]notification_tokens|doc\(currentToken\)" --glob "*.html"
```

期待結果：どちらも一致0件。`index.html`は通知モジュールを自動初期化せず、既存ページ機能は動作する。

## 完了判定

- ON、OFF、tokenローテーション、再読込、複数タブ、権限変更、非対応、主要エラーを上記期待結果どおり確認する。
- HTMLから `notification_tokens` への直接read/writeが0件である。
- このPhaseで確認できるのは購読基盤まで。新着投稿をCloud RunからPush配信する処理は未実装。

## 16. Test A: ON系429後でもOFFできる

1. statusまたはsubscribeが429を返すようにstubする。
2. ONを試行し、Retry-Afterが設定される。
3. Retry-After期間中にユーザーがOFFボタンを押す。

期待結果：ON系backoffは維持される。unsubscribeはブロックされずに即座に呼ばれる。getTokenは呼ばれない。

## 17. Test B: OFF系429はOFF側だけ抑止

1. unsubscribeが429を返すようにstubする。
2. OFFを試行する。

期待結果：desired=false, pending=trueを維持する。OFF完了表示にはならず、「解除待ち」となる。Retry-After中の自動unsubscribe再送は抑止される。

## 18. Test C: unsubscribe 200でも enabled:true

1. unsubscribe APIがHTTP 200で、{"enabled": true, "revision": 10} を返すようにstubする。
2. OFFを試行する。

期待結果：OFF確定しない。pending=falseにしない。deleteTokenしない。OFF完了表示にしない。

## 19. Test D: unsubscribeレスポンス形式不正

1. unsubscribe APIがHTTP 200で {} などを返すようにstubする。
2. OFFを試行する。

期待結果：OFF確定しない。pending OFFを維持する。deleteTokenしない。

## 20. Test E: 正常unsubscribe

1. unsubscribe APIがHTTP 200で、{"enabled": false, "revision": 10} を返すようにstubする。
2. OFFを試行する。

期待結果：pending=falseとなりOFF確定する。serverState=falseになる。deleteTokenがbest-effortで呼ばれる。

## 21. Test F: timeout reconciliation

1. unsubscribeがタイムアウトする。
2. その後の自動リトライ（timeout reconciliation）でstatusがfalseを返す場合。
3. statusがtrueを返す場合。
4. status取得に失敗する場合。

期待結果：status=falseの場合のみOFF確定する。status=trueまたは取得失敗時はpending OFF維持。
