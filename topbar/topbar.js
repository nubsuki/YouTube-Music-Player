const api = window.topbarAPI;

const btnOptions = document.getElementById('btn-options');
const btnRefresh = document.getElementById('btn-refresh');

btnOptions.addEventListener('click', () => {
  api.toggleOptions();
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.classList.add('spinning');
  setTimeout(() => btnRefresh.classList.remove('spinning'), 600);
  api.refreshPage();
});

api.onOptionsToggled((isOpen) => {
  btnOptions.classList.toggle('active', !!isOpen);
});
