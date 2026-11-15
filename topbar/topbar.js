const api = window.topbarAPI;

const btnOptions = document.getElementById('btn-options');
const btnRefresh = document.getElementById('btn-refresh');
const btnQuit = document.getElementById('btn-quit');

btnOptions.addEventListener('click', () => {
  api.toggleOptions();
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.classList.add('spinning');
  setTimeout(() => btnRefresh.classList.remove('spinning'), 600);
  api.refreshPage();
});

if (btnQuit) {
  btnQuit.addEventListener('click', () => {
    api.quitApp();
  });
}

api.onOptionsToggled((isOpen) => {
  btnOptions.classList.toggle('active', !!isOpen);
});
