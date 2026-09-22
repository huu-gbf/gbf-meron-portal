/* Shared input transport only. Prediction functions remain in yosen-predictor.html. */
(async () => {
  'use strict';
  const ADMIN_UID = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
  const $ = id => document.getElementById(id);
  const days = {weekday:'平日', saturday:'土曜', sunday:'日曜', holiday:'祝日'};
  let latest = null, ready = false, dirty = false, saving = false, admin = false, pendingPublish = null;
  let auth, db, ref;
  const safeScore = v => Number.isSafeInteger(v) && v >= 0;
  const safeEarlySpeed = v => Number.isSafeInteger(v) && v > 0;
  const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().slice(0,10) === v;
  function validData(d) {
    return d && d.schemaVersion === 1 && validDate(d.eventDate) && Object.hasOwn(days,d.dayType) && safeScore(d.score12)
      && (d.earlyAvgSpeed == null || safeEarlySpeed(d.earlyAvgSpeed))

      && (d.score18 === null || (safeScore(d.score18) && d.score18 > d.score12))
      && (d.score20 === null || (d.score18 !== null && safeScore(d.score20) && d.score20 > d.score18))
      && d.updatedAt && typeof d.updatedAt.toDate === 'function';
  }
  function fillDraft() {
    $('editDate').value=latest?.eventDate||''; $('editDay').value=latest?.dayType||'weekday';
    const s12 = latest?.score12;
    const earlyAvg = latest?.earlyAvgSpeed;
    let s7 = null;
    if (s12 != null && earlyAvg != null) {
      s7 = s12 - earlyAvg * 50000;
    }
    $('edit7').value = s7 != null && s7 >= 0 ? String(s7) : '';
    for(const hour of ['12','18','20']) $('edit'+hour).value=latest?.['score'+hour] == null ? '' : String(latest['score'+hour]);

    if (s7 != null && s12 != null && s12 > s7) {
      const speedRaw = (s12 - s7) / 5;
      const speedMan = speedRaw / 10000;
      const speedOku = speedRaw / 100000000;
      $('editEarlyAvgSpeed').value = `${speedMan.toLocaleString(undefined, {maximumFractionDigits: 0})} 万/h （約${speedOku.toFixed(2)}億/h）`;
    } else {
      $('editEarlyAvgSpeed').value = '';
    }
    dirty=false;
  }
  function buttons() {
    $('adminPanel').hidden=!admin; $('publishButton').disabled=!admin||!ready||saving;
    $('resetDraft').disabled=!ready||saving;
    for(const element of $('publishForm').elements) if(element.tagName!=='BUTTON') element.disabled=saving;
  }
  function readDraft() {
    const raw7 = $('edit7').value.trim();
    const raw12 = $('edit12').value.trim();
    const s7 = parseNumber(raw7);
    const s12 = parseNumber(raw12);
    let earlyAvgSpeed = null;
    if (raw7 !== '' && raw12 !== '' && !isNaN(s7) && !isNaN(s12) && s12 > s7) {
      earlyAvgSpeed = ((s12 - s7) / 5) / 10000;
    }
    return {schemaVersion:1,eventDate:$('editDate').value,dayType:$('editDay').value,earlyAvgSpeed,
      score12:s12,score18:$('edit18').value.trim()===''?null:parseNumber($('edit18').value),score20:$('edit20').value.trim()===''?null:parseNumber($('edit20').value),updatedAt:{toDate:()=>new Date()}};
  }
  function dropStaleEveningScores(d, previous) {
    if (!previous) return d;
    // 前回の実測値を引き継いだまま12時値を更新した場合だけ、矛盾する旧値を空欄にする。
    if (d.score18 !== null && d.score18 <= d.score12 && d.score18 === previous.score18
        && (d.score12 !== previous.score12 || d.eventDate !== previous.eventDate)
        && (d.score20 === null || d.score20 === previous.score20)) {
      d.score18 = null;
      d.score20 = null;
    } else if (d.score20 !== null && d.score18 !== null && d.score20 <= d.score18
        && d.score20 === previous.score20
        && (d.score18 !== previous.score18 || d.eventDate !== previous.eventDate)) {
      d.score20 = null;
    }
    return d;
  }
  function preview() {
    if(!admin||!ready||saving)return;
    dirty=true;
    const raw7 = $('edit7').value.trim();
    const raw12 = $('edit12').value.trim();
    const s7 = parseNumber(raw7);
    const s12 = parseNumber(raw12);
    if (raw7 !== '' && raw12 !== '' && !isNaN(s7) && !isNaN(s12) && s12 > s7) {
      const speedRaw = (s12 - s7) / 5;
      const speedMan = speedRaw / 10000;
      const speedOku = speedRaw / 100000000;
      $('editEarlyAvgSpeed').value = `${speedMan.toLocaleString(undefined, {maximumFractionDigits: 0})} 万/h （約${speedOku.toFixed(2)}億/h）`;
    } else {
      $('editEarlyAvgSpeed').value = '';
    }
    const d=readDraft();
    els.dayType.value=d.dayType; $('sharedDay').textContent=days[d.dayType];
    for(const hour of ['12','18','20']) {
      const input=$('edit'+hour).value.trim();
      els['score'+hour].value=input;
      $('shared'+hour).textContent=input===''?'未入力':Number.isFinite(d['score'+hour])?formatOku(d['score'+hour]):'入力を確認してください';
    }
    globalThis.yosenEarlyAvgSpeed=safeEarlySpeed(d.earlyAvgSpeed)?d.earlyAvgSpeed:null;
    const score7=safeEarlySpeed(d.earlyAvgSpeed)&&Number.isFinite(d.score12)?d.score12-d.earlyAvgSpeed*50000:null;
    els.score7.value=Number.isSafeInteger(score7)&&score7>=0?String(score7):'';
    $('shared7').textContent=els.score7.value?formatOku(score7):'未登録';
    $('sharedEarlyAvgSpeed').textContent=!$('editEarlyAvgSpeed').value.trim()?'未入力':safeEarlySpeed(d.earlyAvgSpeed)?(d.earlyAvgSpeed/10000).toFixed(2)+'億/h':'入力を確認してください';
    calculate(); document.body.classList.add('shared-ready');
    $('sharedMeta').textContent='未公開の入力値　対象日：'+(d.eventDate||'未入力');
    $('sharedMeta').hidden=false;
    $('sharedStatus').textContent=!safeScore(d.score12)||!safeEarlySpeed(d.earlyAvgSpeed)?'必要なデータを入力すると予測が表示されます。':'';
    $('previewNotice').hidden=false;
  }
  function publishedMatches(d, submitted) {
    return d && submitted && ['schemaVersion','eventDate','dayType','earlyAvgSpeed','score12','score18','score20'].every(key=>d[key]===submitted[key]);
  }
  function finishPublish() {
    pendingPublish=null;fillDraft();render(latest);
    $('adminStatus').textContent='公開データを更新しました。';
  }
  function clearShared(message) {
    document.body.classList.remove('shared-ready'); $('sharedMeta').hidden=true;
    $('result12').style.display='none'; $('calcDetails').style.display='none'; $('calcExplanation').textContent='';
    for(const hour of ['7','12','18','20']) { els['score'+hour].value=''; $('shared'+hour).textContent=''; }
    $('sharedEarlyAvgSpeed').textContent=''; globalThis.yosenEarlyAvgSpeed=null;
    $('sharedStatus').textContent=message;
  }
  function render(d) {
    $('previewNotice').hidden=true;
    if(!d) {
      clearShared('現在、予選データはまだ登録されていません。');
      $('calcExplanation').textContent='当日のデータが登録されると表示されます。';
      $('calcDetails').style.display='block';
      return;
    }
    els.dayType.value=d.dayType; $('sharedDay').textContent=days[d.dayType];
    const score7=d.earlyAvgSpeed == null ? null : d.score12-d.earlyAvgSpeed*50000;
    els.score7.value=Number.isSafeInteger(score7)&&score7>=0?String(score7):'';
    $('shared7').textContent=els.score7.value?formatOku(score7):'未登録';
    for(const hour of ['12','18','20']) { const value=d['score'+hour]; els['score'+hour].value=value===null?'':String(value); $('shared'+hour).textContent=value===null?'未登録':formatOku(value); }
    globalThis.yosenEarlyAvgSpeed=d.earlyAvgSpeed ?? null;
    $('sharedEarlyAvgSpeed').textContent=d.earlyAvgSpeed == null ? '未登録' : (d.earlyAvgSpeed/10000).toFixed(2)+'億/h';
    calculate(); document.body.classList.add('shared-ready');
    $('sharedMeta').textContent='対象日：'+d.eventDate.replaceAll('-','/')+'　最終更新：'+new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d.updatedAt.toDate());
    $('sharedMeta').hidden=false; $('sharedStatus').textContent='';
  }
  $('publishForm').addEventListener('input',preview);
  $('publishForm').addEventListener('change',preview);
  $('resetDraft').onclick=()=>{fillDraft(); render(latest); $('adminStatus').textContent='公開値を編集欄に読み込みました。';};
  $('loginToggle').onclick=()=>{$('loginForm').hidden=!$('loginForm').hidden;};
  $('loginForm').onsubmit=async e=>{
    e.preventDefault(); $('signIn').disabled=true; $('adminStatus').textContent='ログインしています…';
    try { if(!auth) throw Error('認証サービスを利用できません。再読み込みしてください。'); await auth.signInWithEmailAndPassword($('adminEmail').value.trim(),$('adminPassword').value); }
    catch(error) { $('adminStatus').textContent='ログインに失敗しました。'+(error.code||error.message); }
    finally { $('adminPassword').value=''; $('signIn').disabled=false; }
  };
  $('signOut').onclick=async()=>{try{await auth.signOut();}catch(e){$('adminStatus').textContent='ログアウトに失敗しました。'+(e.code||'');}};
  $('publishForm').onsubmit=async e=>{
    e.preventDefault(); if(!admin||!ready||saving||auth.currentUser?.uid!==ADMIN_UID)return;
    const raw7 = $('edit7').value.trim();
    const raw12 = $('edit12').value.trim();
    if (!raw7) { $('adminStatus').textContent='7時の累計貢献度を入力してください。'; return; }
    if (!raw12) { $('adminStatus').textContent='12時の累計貢献度を入力してください。'; return; }
    const s7 = parseNumber(raw7);
    const s12 = parseNumber(raw12);
    if (isNaN(s7) || isNaN(s12)) { $('adminStatus').textContent='累計貢献度は正しい数字を入力してください。'; return; }
    if (s12 <= s7) { $('adminStatus').textContent='12時の累計貢献度は7時より大きい値を入力してください。'; return; }

    const d=dropStaleEveningScores(readDraft(), latest);
    if(!validData(d)){ $('adminStatus').textContent='対象日・開催条件・平均時速・累計を確認してください。12時累計は必須、18時・20時は順に大きい値を入力してください。';return; }
    saving=true;pendingPublish={data:d,confirmed:false};buttons();$('adminStatus').textContent='保存しています…';
    try {
      await ref.set({...d,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      if(pendingPublish?.confirmed || publishedMatches(latest,d)) finishPublish();
      else $('adminStatus').textContent='保存が完了しました。公開データの反映を確認しています…';
    } catch(error) { pendingPublish=null; $('adminStatus').textContent='保存に失敗しました。入力内容は残っています。'+(error.code||''); }
    finally {saving=false;buttons();}
  };
  try {
    const app=firebase.initializeApp(globalThis.firebaseConfig,'yosen-shared');auth=app.auth();db=app.firestore();ref=db.doc('publicTools/yosenPredictor');
    // No Firestore persistence or legacy input localStorage is used.
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
    auth.onAuthStateChanged(user=>{
      const wasAdmin=admin;admin=user?.uid===ADMIN_UID;
      $('signOut').hidden=!user; $('loginToggle').hidden=!!user; $('loginForm').hidden=true;
      $('adminStatus').textContent=user?(admin?'管理モードです。':'このアカウントには編集権限がありません。'):'';
      if(!admin||!wasAdmin) { fillDraft(); render(latest); } buttons();
    });
    ref.onSnapshot({includeMetadataChanges:true},snapshot=>{
      // Do not publish cached or unacknowledged local writes as shared data.
      if(snapshot.metadata.hasPendingWrites)return;
      if(snapshot.metadata.fromCache){ready=false;buttons();clearShared('最新データを読み込んでいます…');return;}
      const d=snapshot.exists?snapshot.data():null;
      if(d&&!validData(d)){ready=false;buttons();clearShared('公開データの形式を確認できませんでした。管理人へお知らせください。');return;}
      latest=d;ready=true;
      if(pendingPublish && publishedMatches(d,pendingPublish.data)) {
        pendingPublish.confirmed=true;
        if(!saving)finishPublish();
      } else if(!admin||!dirty) { render(d);if(!saving)fillDraft(); }
      buttons();
    },error=>{ready=false;buttons();clearShared('最新データを取得できませんでした。時間をおいて再読み込みしてください。');});
  }catch(error){ready=false;buttons();clearShared('最新データを取得できませんでした。時間をおいて再読み込みしてください。');$('adminStatus').textContent='接続初期化に失敗しました。'+(error.code||error.message);}
})();
