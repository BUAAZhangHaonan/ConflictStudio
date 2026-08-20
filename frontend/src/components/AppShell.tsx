import { useEffect, useId, useRef, useState, type PropsWithChildren } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setPreferredLocale, usePreferences } from '../preferences';

const primaryNavigation = [
  { to: '/workspace', key: 'workspace' },
  { to: '/generate/test', key: 'generate' },
  { to: '/review', key: 'review' },
  { to: '/archive', key: 'archive' },
  { to: '/settings', key: 'settings' },
] as const;

const generateNavigation = [
  { to: '/generate/test', key: 'test' },
  { to: '/generate/production', key: 'production' },
  { to: '/generate/results', key: 'results' },
] as const;

const focusableSelector = [
  'button:not([disabled]):not([tabindex="-1"])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function currentPrimaryPath(pathname: string): string | null {
  if (pathname.startsWith('/generate')) return '/generate/test';
  if (pathname.startsWith('/review')) return '/review';
  if (pathname === '/workspace' || pathname === '/archive' || pathname === '/settings') return pathname;
  return null;
}

function pageTitleKey(pathname: string): string {
  if (pathname === '/workspace') return 'workspace.title';
  if (pathname.startsWith('/generate')) return 'generate.title';
  if (pathname.startsWith('/review')) return 'review.title';
  if (pathname === '/archive') return 'archive.title';
  if (pathname === '/settings') return 'settings.title';
  if (pathname === '/me/statistics') return 'statistics.title';
  return 'notFound.title';
}

export function AppShell({ children }: PropsWithChildren) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const preferences = usePreferences();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const activePrimaryPath = currentPrimaryPath(location.pathname);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const reviewerMenuRef = useRef<HTMLDetailsElement>(null);
  const drawerButtonRef = useRef<HTMLButtonElement>(null);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const drawerOverflowRef = useRef<string | null>(null);
  const wasDrawerOpenRef = useRef(false);
  const drawerId = useId();
  const drawerTitleId = useId();

  useEffect(() => {
    setDrawerOpen(false);
    if (reviewerMenuRef.current) reviewerMenuRef.current.open = false;
  }, [location.pathname]);
  useEffect(() => {
    document.documentElement.lang = preferences.locale;
    document.title = t('app.pageTitle', { page: t(pageTitleKey(location.pathname)) });
  }, [location.pathname, preferences.locale, t]);
  useEffect(() => {
    const dialog = drawerRef.current;
    if (!dialog) return;

    if (drawerOpen) {
      if (!dialog.open) {
        drawerReturnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : drawerButtonRef.current;
        drawerOverflowRef.current = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialog.showModal();
        window.requestAnimationFrame(() => {
          const preferred = dialog.querySelector<HTMLElement>(focusableSelector);
          (preferred ?? dialog).focus();
        });
      }
    } else {
      if (dialog.open) dialog.close();
      if (drawerOverflowRef.current !== null) {
        document.body.style.overflow = drawerOverflowRef.current;
        drawerOverflowRef.current = null;
      }
    }

    return () => {
      if (drawerOverflowRef.current !== null) {
        document.body.style.overflow = drawerOverflowRef.current;
        drawerOverflowRef.current = null;
      }
    };
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const dialog = drawerRef.current;
    if (!dialog) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);
  useEffect(() => {
    if (wasDrawerOpenRef.current && !drawerOpen) {
      window.requestAnimationFrame(() => drawerReturnFocusRef.current?.focus());
    }
    wasDrawerOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  const toggleLocale = () => {
    const locale = preferences.locale === 'zh-CN' ? 'en-US' : 'zh-CN';
    setPreferredLocale(locale);
    void i18n.changeLanguage(locale);
  };

  const closeReviewerMenu = () => {
    if (reviewerMenuRef.current) reviewerMenuRef.current.open = false;
  };

  const navigation = (
    <>
      <div className="app-shell__brand">{t('app.product')}</div>
      <nav className="primary-nav" aria-label={t('app.mainNavigation')}>
        {primaryNavigation.map(item => {
          const isCurrent = activePrimaryPath === item.to;
          return (
            <Link
              key={item.key}
              to={item.to}
              className={`primary-nav__link ${isCurrent ? 'is-active' : ''}`}
              aria-current={isCurrent ? 'page' : undefined}
            >
              <span>{t(`nav.${item.key}`)}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('app.skipToContent')}</a>
      <aside className="app-shell__sidebar">{navigation}</aside>
      <dialog
        ref={drawerRef}
        id={drawerId}
        className={`mobile-drawer ${drawerOpen ? 'is-open' : ''}`}
        aria-modal="true"
        aria-labelledby={drawerTitleId}
        tabIndex={-1}
        onCancel={event => {
          event.preventDefault();
          setDrawerOpen(false);
        }}
      >
        <button
          type="button"
          className="mobile-drawer__backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-label={t('app.closeNavigation')}
          tabIndex={-1}
        />
        <aside className="mobile-drawer__panel">
          <h2 className="mobile-drawer__title" id={drawerTitleId}>
            {t('app.mainNavigation')}
          </h2>
          {navigation}
          <button type="button" className="text-button mobile-drawer__language" onClick={toggleLocale}>
            {t('app.changeLanguage')}
          </button>
        </aside>
      </dialog>
      <div className="app-shell__body">
        <header className="topbar">
          <div className="topbar__title">
            <button
              ref={drawerButtonRef}
              type="button"
              className="icon-button topbar__menu"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('app.openNavigation')}
              aria-expanded={drawerOpen}
              aria-controls={drawerId}
            >
              <span className="topbar__menu-icon" aria-hidden="true" />
            </button>
            <span>{t(pageTitleKey(location.pathname))}</span>
          </div>
          <div className="topbar__actions">
            <button type="button" className="text-button topbar__language" onClick={toggleLocale}>
              {t('app.changeLanguage')}
            </button>
            <details
              ref={reviewerMenuRef}
              className="reviewer-menu"
              onKeyDown={event => {
                if (event.key !== 'Escape' || !reviewerMenuRef.current?.open) return;
                event.preventDefault();
                reviewerMenuRef.current.open = false;
                reviewerMenuRef.current.querySelector('summary')?.focus();
              }}
            >
              <summary aria-label={t('app.reviewerMenu')}>
                <span className="reviewer-menu__symbol" aria-hidden="true" />
                {preferences.currentReviewerName ?? t('reviewer.noCurrent')}
              </summary>
              <div className="reviewer-menu__panel">
                <span>{t('app.currentReviewer')}</span>
                <strong>{preferences.currentReviewerName ?? t('reviewer.noCurrent')}</strong>
                <NavLink to="/me/statistics" onClick={closeReviewerMenu}>{t('actions.viewStatistics')}</NavLink>
                <NavLink to="/settings" onClick={closeReviewerMenu}>{t('nav.settings')}</NavLink>
              </div>
            </details>
          </div>
        </header>
        {location.pathname.startsWith('/generate') ? (
          <nav className="generate-nav" aria-label={t('app.generateNavigation')}>
            {generateNavigation.map(item => (
              <NavLink key={item.key} to={item.to} className={({ isActive }) => (isActive ? 'is-active' : '')}>
                {t(`nav.${item.key}`)}
              </NavLink>
            ))}
          </nav>
        ) : null}
        <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
