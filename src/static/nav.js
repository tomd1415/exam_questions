(function () {
  var toggle = document.querySelector('[data-nav-toggle]');
  var drawer = document.getElementById('primary-nav-drawer');
  if (!toggle || !drawer) return;
  toggle.addEventListener('click', function () {
    var open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    drawer.classList.toggle('site-nav__list--open', !open);
  });
})();
