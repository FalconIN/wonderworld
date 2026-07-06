(function () {
  let currentGroup = [];
  let currentIndex = 0;
  let touchStartX = 0;
  let touchStartY = 0;

  function groupImages(imgEl) {
    const group = imgEl.closest('[data-gallery-group]');
    return Array.from(group.querySelectorAll('.gallery-thumb'));
  }

  function render() {
    const item = currentGroup[currentIndex];
    const img = document.getElementById('lightboxImg');
    img.src = item.dataset.full;
    img.alt = item.alt;
    document.getElementById('lightboxCounter').textContent = (currentIndex + 1) + ' / ' + currentGroup.length;
  }

  window.openLightbox = function (imgEl) {
    currentGroup = groupImages(imgEl);
    currentIndex = currentGroup.indexOf(imgEl);
    render();
    document.getElementById('lightboxOverlay').classList.add('is-open');
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown);
  };

  window.closeLightbox = function () {
    document.getElementById('lightboxOverlay').classList.remove('is-open');
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKeydown);
  };

  window.lightboxStep = function (delta) {
    if (!currentGroup.length) return;
    currentIndex = (currentIndex + delta + currentGroup.length) % currentGroup.length;
    render();
  };

  function onKeydown(e) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lightboxStep(-1);
    else if (e.key === 'ArrowRight') lightboxStep(1);
  }

  document.addEventListener('DOMContentLoaded', function () {
    const stage = document.querySelector('.lightbox-stage');
    if (stage) {
      stage.addEventListener('touchstart', function (e) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          lightboxStep(dx < 0 ? 1 : -1);
        }
      }, { passive: true });
    }

    const revealTargets = document.querySelectorAll('.gallery-reveal');
    if (!revealTargets.length) return;
    const revealObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    revealTargets.forEach(function (el) { revealObs.observe(el); });
  });
})();
