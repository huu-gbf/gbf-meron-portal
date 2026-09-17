/* Shared input transport only. Prediction functions remain in yosen-predictor.html. */
(async () => {
  'use strict';
  const ADMIN_UID = 'wJRZibao8FgMDqDDQ3csPdVuGkx1';
  const $ = id => document.getElementById(id);
  const days = {weekday:'平日', saturday:'土曜', sunday:'日曜', holiday:'祝日'};
  let latest = null, ready = false, dirty = false, saving = false, admin = false;
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
    $('editEarlyAvgSpeed').value=latest?.earlyAvgSpeed == null ? '' : String(latest.earlyAvgSpeed);
    for(const hour of ['12','18','20']) $('edit'+hour).value=latest?.['score'+hour] == null ? '' : String(latest['score'+hour]);
    dirty=false;
  }
  function buttons() {
    $('adminPanel').hidden=!admin; $('publishButton').disabled=!admin||!ready||saving;
    $('resetDraft').disabled=!ready||saving;
    for(const element of $('publishForm').elements) if(element.tagName!=='BUTTON') element.disabled=saving;
  }
  function clearShared(message) {
    document.body.classList.remove('shared-ready'); $('sharedMeta').hidden=true;
    $('calcDetails').style.display='none'; $('calcExplanation').textContent='';
    for(const hour of ['12','18','20']) { els['score'+hour].value=''; $('shared'+hour).textContent=''; }
    $('sharedEarlyAvgSpeed').textContent=''; globalThis.yosenEarlyAvgSpeed=null;
    $('sharedStatus').textContent=message;
  }
  function render(d) {
    if(!d) {
      clearShared('現在、予選データはまだ登録されていません。');
      $('calcExplanation').textContent='当日のデータが登録されると表示されます。';
      $('calcDetails').style.display='block';
      return;
    }
    els.dayType.value=d.dayType; $('sharedDay').textContent=days[d.dayType];
    for(const hour of ['12','18','20']) { const value=d['score'+hour]; els['score'+hour].value=value===null?'':String(value); $('shared'+hour).textContent=value===null?'未登録':formatOku(value); }
    globalThis.yosenEarlyAvgSpeed=d.earlyAvgSpeed ?? null;
    $('sharedEarlyAvgSpeed').textContent=d.earlyAvgSpeed == null ? '未登録' : (d.earlyAvgSpeed/10000).toFixed(2)+'億/h';
    calculate(); document.body.classList.add('shared-ready');
    $('sharedMeta').textContent='対象日：'+d.eventDate.replaceAll('-','/')+'　最終更新：'+new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d.updatedAt.toDate());
    $('sharedMeta').hidden=false; $('sharedStatus').textContent='';
  }
  $('publishForm').addEventListener('input',()=>{dirty=true;});
  $('resetDraft').onclick=()=>{fillDraft(); $('adminStatus').textContent='公開値を編集欄に読み込みました。';};
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
    const earlyInput=$('editEarlyAvgSpeed').value.trim();
    const parsedEarly=earlyInput ? parseNumber(earlyInput) : null;
    const earlyAvgSpeed=parsedEarly === null ? null : /[億万]/.test(earlyInput) ? parsedEarly/10000 : parsedEarly;
    const d={schemaVersion:1,eventDate:$('editDate').value,dayType:$('editDay').value,earlyAvgSpeed,
      score12:parseNumber($('edit12').value),score18:$('edit18').value.trim()===''?null:parseNumber($('edit18').value),score20:$('edit20').value.trim()===''?null:parseNumber($('edit20').value),updatedAt:{toDate:()=>new Date()}};
    if(!validData(d)){ $('adminStatus').textContent='対象日・開催条件・平均時速・累計を確認してください。12時累計は必須、18時・20時は順に大きい値を入力してください。';return; }
    saving=true;buttons();$('adminStatus').textContent='保存しています…';
    try {
      await ref.set({...d,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      dirty=false; $('adminStatus').textContent='公開データを更新しました。';
    } catch(error) { $('adminStatus').textContent='保存に失敗しました。入力内容は残っています。'+(error.code||''); }
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
      if(!admin||!wasAdmin)fillDraft();buttons();
    });
    ref.onSnapshot({includeMetadataChanges:true},snapshot=>{
      // Do not publish cached or unacknowledged local writes as shared data.
      if(snapshot.metadata.hasPendingWrites)return;
      if(snapshot.metadata.fromCache){ready=false;buttons();clearShared('最新データを読み込んでいます…');return;}
      const d=snapshot.exists?snapshot.data():null;
      if(d&&!validData(d)){ready=false;buttons();clearShared('公開データの形式を確認できませんでした。管理人へお知らせください。');return;}
      latest=d;ready=true;render(d);if(!dirty&&!saving)fillDraft();buttons();
    },error=>{ready=false;buttons();clearShared('最新データを取得できませんでした。時間をおいて再読み込みしてください。');});
  }catch(error){ready=false;buttons();clearShared('最新データを取得できませんでした。時間をおいて再読み込みしてください。');$('adminStatus').textContent='接続初期化に失敗しました。'+(error.code||error.message);}
})();
