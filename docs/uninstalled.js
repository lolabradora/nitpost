(() => {
  const question = document.getElementById('reasons');
  const thanks = document.getElementById('reason-thanks');
  let answered = false;
  question.hidden = false;
  question.addEventListener('click', event => {
    const reason = event.target.closest('button[data-reason]');
    if (!reason || answered) return;
    answered = true;
    window.nitpostSignals?.countReason(reason.dataset.reason);
    for (const part of question.querySelectorAll('.reason-ask')) part.remove();
    thanks.hidden = false;
    thanks.focus();
  });
})();
