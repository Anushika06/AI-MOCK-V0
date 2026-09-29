import { Link, NavLink, Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="18" height="18"><path d="M8 17l5 5 11-12" /></svg>
            </span>
            <span className="brand-name">Super TET <span className="brand-sub">Practice</span></span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/history">History</NavLink>
          </nav>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </div>
  );
}
