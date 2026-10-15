import { useEffect, useState, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, ShoppingBag, Package, Truck, Factory, Workflow, ShieldCheck, Layers, Users, Wallet, ChartNoAxesCombined, Settings, Search, Bell, ChevronsUpDown, LogOut, Menu, Command, CircleHelp, ChevronRight, ClipboardList, type LucideIcon, } from 'lucide-react';
import { can, type Area, type PageResponse, type OrderSummary } from '@loomos/shared';
import { useAuth } from '../../features/auth/Auth';
import { useData, useLiveUpdates, useNotificationFeed } from '../../hooks/useFactory';
import { label } from '../../lib/utils';
import { GlobalSearchModal } from './GlobalSearchModal';
import { NotificationsModal } from './NotificationsModal';
import { HelpModal } from './HelpModal';
import { QuickAdd } from './QuickAdd';
interface NavSection {
    name: string;
    items: [
        string,
        string,
        LucideIcon,
        Area
    ][];
}
const sections: NavSection[] = [
    {
        name: 'WORKSPACE',
        items: [
            ['Overview', '/', LayoutDashboard, 'dashboard'],
            ['Orders', '/orders', ShoppingBag, 'orders'],
            ['Inventory', '/inventory', Package, 'inventory'],
            ['Procurement', '/procurement', Package, 'procurement'],
        ],
    },
    {
        name: 'FACTORY OPERATIONS',
        items: [
            ['Production', '/production', Workflow, 'production'],
            ['Batches & rework', '/batches', ClipboardList, 'production'],
            ['Machine floor', '/machines', Factory, 'machines'],
            ['Quality control', '/quality', ShieldCheck, 'quality'],
            ['Finished rolls', '/rolls', Layers, 'rolls'],
            ['Dispatch', '/dispatch', Truck, 'dispatch'],
        ],
    },
    {
        name: 'BUSINESS',
        items: [
            ['Workers & shifts', '/workforce', Users, 'workforce'],
            ['Finance', '/finance', Wallet, 'finance'],
            ['Reports', '/reports', ChartNoAxesCombined, 'reports'],
        ],
    },
];
export function Workspace() {
    const { user, logout } = useAuth();
    const location = useLocation();
    const [mobile, setMobile] = useState(false);
    const [search, setSearch] = useState(false);
    const [notifications, setNotifications] = useState(false);
    const [help, setHelp] = useState(false);
    const live = useLiveUpdates();
    const [userMenuOpen, setUserMenuOpen] = useState(false);
    const userMenuRef = useRef<HTMLDivElement>(null);
    const { feed, markRead } = useNotificationFeed();
    const unread = feed.data?.unread ?? 0;
    const orders = useData<PageResponse<OrderSummary>>('/orders?pageSize=100', can(user.role, 'orders'));

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
                setUserMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);
    useEffect(() => {
        const listener = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                setSearch((v) => !v);
            }
        };
        window.addEventListener('keydown', listener);
        return () => window.removeEventListener('keydown', listener);
    }, []);
    useEffect(() => setMobile(false), [location.pathname]);
    const all = sections.flatMap((s) => s.items);
    const title = user.role === 'BUYER'
        ? 'Buyer workspace'
        : all.find((i) => i[1] === location.pathname)?.[0] ??
            (location.pathname.startsWith('/orders/')
                ? 'Order details'
                : location.pathname.startsWith('/rolls/')
                    ? 'Roll passport'
                    : 'Settings');

    return (
      <div className="workspace">
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
      {mobile && (<button className="sidebar-scrim" onClick={() => setMobile(false)} aria-label="Close menu"/>)}

      <aside className={`sidebar ${mobile ? 'sidebar-open' : ''}`}>
        <NavLink to="/" className="brand">
          <div className="brand-mark">
            <Layers size={24}/>
          </div>
          Loom<span>OS</span>
          <span className="brand-period">.</span>
        </NavLink>

        <button className="mill-switch" onClick={() => setHelp(true)}>
          <span className="mill-avatar">
            <Factory size={19}/>
          </span>
          <span>
            <strong>Everest Textile Mills</strong>
            <small>Manufacturing workspace</small>
          </span>
          <ChevronsUpDown size={14}/>
        </button>

        <nav aria-label="Main navigation">
          {user.role === 'BUYER' ? (<div className="nav-section">
              <span>YOUR WORKSPACE</span>
              <NavLink to="/buyer">
                <ShoppingBag size={18}/>
                Your orders
              </NavLink>
            </div>) : (sections.map((section) => (<div className="nav-section" key={section.name}>
                {section.items.some((i) => can(user.role, i[3])) && (<span>{section.name}</span>)}
                {section.items
                .filter((i) => can(user.role, i[3]))
                .map(([name, path, Icon]) => (<NavLink key={path} to={path} end={path === '/'}>
                      <Icon size={18}/>
                      <span>{name}</span>
                      {name === 'Machine floor' && (<span className={`nav-dot ${live ? 'online' : ''}`}/>)}
                    </NavLink>))}
              </div>)))}
        </nav>

        <div className="sidebar-bottom">
          {can(user.role, 'settings') && (<NavLink className="bottom-link" to="/settings">
              <Settings size={18}/>
              Settings
            </NavLink>)}

          <button className="bottom-link" onClick={() => setHelp(true)}>
            <CircleHelp size={18}/>
            Help & getting started
          </button>

          <div className="sidebar-user">
            <span className="avatar avatar-user">
              {user.name
            .split(' ')
            .slice(0, 2)
            .map((n) => n[0])
            .join('')}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>{label(user.role)}</small>
            </div>
            <button className="icon-button" onClick={logout} aria-label="Sign out">
              <LogOut size={16}/>
            </button>
          </div>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="icon-button mobile-menu" onClick={() => setMobile(true)} aria-label="Open navigation">
              <Menu size={20}/>
            </button>
            <span>Workspace</span>
            <ChevronRight size={13}/>
            <strong>{title}</strong>
          </div>

          <div className="topbar-actions">
            {user.role !== 'BUYER' && <QuickAdd user={user} orders={orders.data?.data ?? []} />}
            <button className="global-search" onClick={() => setSearch(true)}>
              <Search size={16}/>
              <span>Search anything...</span>
              <kbd>
                <Command size={10}/> K
              </kbd>
            </button>
            <span className="topbar-divider"/>
            <span className={`live-indicator ${live ? 'is-live' : ''}`}>
              <i />
              {live ? 'Live updates' : 'Updates offline'}
            </span>
            <button className="notification-button" onClick={() => setNotifications(true)} aria-label={`View notifications${unread ? ` (${unread} unread)` : ''}`}>
                <Bell size={19}/>
                {unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}
              </button>
            <div className="topbar-user" ref={userMenuRef} style={{ position: 'relative' }}>
              <button
                className="topbar-user-trigger"
                onClick={() => setUserMenuOpen((v) => !v)}
                aria-label="User account menu"
                aria-expanded={userMenuOpen}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px',
                  borderRadius: '6px',
                }}
              >
                <span className="avatar avatar-top">
                  {user.name
                    .split(' ')
                    .slice(0, 2)
                    .map((n) => n[0])
                    .join('')}
                </span>
                <ChevronsUpDown size={12} style={{ opacity: 0.5 }} />
              </button>

              {userMenuOpen && (
                <div
                  className="topbar-user-dropdown"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: '230px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #dcdfd8',
                    borderRadius: '8px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                    zIndex: 1000,
                    padding: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ borderBottom: '1px solid #edf0ea', paddingBottom: '8px' }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: '#1b2d22' }}>
                      {user.name}
                    </div>
                    <div style={{ fontSize: '12px', color: '#3b4049', marginTop: '2px' }}>
                      {user.email}
                    </div>
                    <div style={{ marginTop: '6px' }}>
                      <span className="badge badge-green" style={{ fontSize: '12px', padding: '2px 6px' }}>
                        {label(user.role)}
                      </span>
                    </div>
                  </div>

                  <button
                    className="button"
                    onClick={() => {
                      setUserMenuOpen(false);
                      void logout();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '8px',
                      backgroundColor: '#fff4f2',
                      color: '#b42318',
                      border: '1px solid #fecdca',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    <LogOut size={15} />
                    <span>Log out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="page-content" id="main-content">
          <Outlet />
        </main>

        <footer className="workspace-footer">
          <span>
            <span className="footer-mark">✳</span> LoomOS <span>·</span> Factory operations
          </span>
          <span>
            Operator-reported production
          </span>
        </footer>
      </div>

      <GlobalSearchModal open={search} onClose={() => setSearch(false)} userRole={user.role} allNavItems={all} ordersData={orders.data}/>

      <NotificationsModal open={notifications} onClose={() => setNotifications(false)} feed={feed.data?.items} unread={unread} onRead={(id) => markRead.mutate(id)}/>

      <HelpModal open={help} onClose={() => setHelp(false)}/>
    </div>);
}
