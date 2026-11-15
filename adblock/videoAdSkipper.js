function injectVideoAdSkipper(webContents, opts) {
  if (!webContents || webContents.isDestroyed()) return;
  const enabled = !!(opts && opts.enabled);
  const speed = (opts && opts.speed) || 2;
  const interval = (opts && opts.interval) || 200;
  webContents.executeJavaScript(
    `(function(){
    window.__ytmpAdSkipperEnabled=${enabled};
    window.__ytmpAdSkipperSpeed=${speed};
    function skipVideoAd(){
    if(!window.__ytmpAdSkipperEnabled)return false;
    try{const skipSelectors=['.ytp-ad-skip-button','.ytp-ad-skip-button-modern','.ytp-skip-ad-button','.ytp-ad-skip-button-container button','button.ytp-ad-skip-button','[class*="skip"][class*="button"]'];
    for(const selector of skipSelectors){const skipButton=document.querySelector(selector);if(skipButton){const isClickable=!skipButton.disabled&&skipButton.offsetParent!==null&&!skipButton.hasAttribute('disabled');
    if(isClickable){skipButton.click();return true;}}}const video=document.querySelector('video');
    if(video){const player=document.querySelector('.html5-video-player');if(player&&(player.classList.contains('ad-showing')||player.classList.contains('ad-interrupting'))){if(video.duration&&video.duration>0&&!isNaN(video.duration)){video.currentTime=Math.max(0,video.duration-0.1);
    video.playbackRate=window.__ytmpAdSkipperSpeed;return true;}}}}catch(e){}return false}
    if(window.__ytmpAdSkipperInterval){console.log('Video ad skipper updated (Enabled: '+window.__ytmpAdSkipperEnabled+', Speed: '+window.__ytmpAdSkipperSpeed+'x)');return;}
    window.__ytmpAdSkipperInterval=setInterval(skipVideoAd,${interval});
    document.addEventListener('DOMContentLoaded',skipVideoAd);
    window.addEventListener('load',skipVideoAd);
    if(document.body){const observer=new MutationObserver(skipVideoAd);
    observer.observe(document.body,{childList:true,subtree:true});}
    console.log('Video ad skipper initialized (Speed: '+window.__ytmpAdSkipperSpeed+'x, Interval: ${interval}ms)');})();`);
}

module.exports = { injectVideoAdSkipper };
