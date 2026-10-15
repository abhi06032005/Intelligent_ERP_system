import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, ArrowDown, Layers, Package, Factory, Workflow, ShieldCheck, Truck, Wallet, Users,
  QrCode, KeyRound, Smartphone, Activity, ShoppingBag, UserRound, Check,
} from 'lucide-react';
import { createThreadScene, type ThreadScene } from './threads';
import { DashboardMock } from './DashboardMock';
import './landing.css';

// The public home page: the loom draws itself in the hero, then one screen for the whole mill,
// how a day at the mill runs, who uses it, buyers, and the rules built in. Nothing here needs a
// session; sign-in lives at /login and the buyer portal signup at /buyer/signup.

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Adds "is-in" the first time an element scrolls into view, so CSS can run its reveal.
function useReveal<T extends HTMLElement>(threshold = 0.18) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion() || !('IntersectionObserver' in window)) { el.classList.add('is-in'); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { el.classList.add('is-in'); io.disconnect(); }
    }, { threshold, rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

function Reveal({ children, className = '', as: Tag = 'div', delay = 0 }: { children: ReactNode; className?: string; as?: 'div' | 'section' | 'article' | 'li'; delay?: number }) {
  const ref = useReveal<HTMLDivElement>();
  const Component = Tag as 'div';
  return <Component ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>{children}</Component>;
}

// The woven threads behind a dark section. Draws only while on screen.
function ThreadCanvas({ scrim = 'none', weaveX, converge, seed, anchor }: { scrim?: 'left' | 'top' | 'none'; weaveX?: number; converge?: boolean; seed?: number; anchor?: React.RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const scene: ThreadScene = createThreadScene(canvas, { background: '#0b0e0c', reducedMotion: reducedMotion(), scrim, weaveX, converge, seed });
    const io = new IntersectionObserver((entries) => scene.setActive(entries.some((e) => e.isIntersecting)), { threshold: 0.02 });
    io.observe(canvas);
    // The underline under the headline word only on wider screens; on phones every thread stays behind the copy.
    const measure = () => scene.setAnchor(anchor?.current && window.innerWidth >= 600 ? anchor.current.getBoundingClientRect() : null);
    measure();
    const ro = anchor?.current ? new ResizeObserver(measure) : null;
    if (anchor?.current && ro) ro.observe(anchor.current);
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure).catch(() => { });
    // The headline lines rise into place over the first second; measure again once they have settled.
    const line = anchor?.current?.closest('.lp-line');
    line?.addEventListener('animationend', measure);
    const settle = window.setTimeout(measure, 2200);
    return () => { scene.destroy(); io.disconnect(); ro?.disconnect(); window.removeEventListener('resize', measure); line?.removeEventListener('animationend', measure); window.clearTimeout(settle); };
  }, [scrim, weaveX, converge, seed, anchor]);
  return <canvas ref={ref} className="lp-threads" aria-hidden="true" />;
}

// The dashboard preview is designed at a fixed size and scaled to whatever width it gets, so it
// never pushes a phone sideways.
function ScaledFrame({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setK(Math.min(1, entry.contentRect.width / width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={ref} className="lp-scaled" style={{ height: height * k }}>
      <div style={{ width, height, transform: `scale(${k})`, transformOrigin: 'top left' }}>{children}</div>
    </div>
  );
}

const STAGES = ['Yarn in at the gate', 'Spinning', 'Weaving', 'Dyeing', 'Inspection', 'Finished rolls', 'Dispatch', 'Delivered', 'Books closed'];

const FLOW = [
  { n: '01', icon: Package, title: 'Yarn in at the gate', text: 'Weigh it, lot it, reserve it for the order that needs it. Low stock and open purchase orders show up before a machine runs dry.' },
  { n: '02', icon: Factory, title: 'Spinning, weaving, dyeing', text: 'A job, a machine, an operator. Target metres against output, started and finished from the floor, blocked or paused jobs flagged within the shift.' },
  { n: '03', icon: ShieldCheck, title: 'Every roll inspected', text: 'The inspector works the queue oldest first: pass, rework or reject with the defects ticked. Each roll carries a passport back to its batch and machine.' },
  { n: '04', icon: Users, title: 'Shifts and wages', text: 'The supervisor checks workers in and out and hands running machines to the next shift. Wages come from attendance, not from a register.' },
  { n: '05', icon: Truck, title: 'Loaded, counted, invoiced', text: 'Only passed rolls can be loaded. Scan each label, confirm the truck, and the invoice matches what left the gate.' },
  { n: '06', icon: Wallet, title: 'The books close themselves', text: 'Sales from orders, wages from attendance, spend from bills. The month’s profit is a number, next to what is outstanding and what is due.' },
];

const ROLES = [
  { role: 'Factory Owner', icon: Layers, text: 'Real-time visibility: open orders, machines, rolls waiting, dispatches, yarn inventory and monthly margin.', dark: true },
  { role: 'Production Manager', icon: Workflow, text: 'Plan batches, monitor machine constraints, track active floor jobs and coordinate rework.' },
  { role: 'Shift Supervisor', icon: Users, text: 'Manage attendance check-in/out, live shift handover, and fast breakdown escalations.' },
  { role: 'Loom Operator', icon: Activity, text: 'Target vs output tracking on assigned frames and rapier looms, right from the floor.' },
  { role: 'Quality Inspector', icon: ShieldCheck, text: 'Roll-by-roll inspection queue, defect logging, and instant passport grading.' },
  { role: 'Dispatch Manager', icon: Truck, text: 'Verified roll truck loading, gate passes, and delivery confirmations.' },
  { role: 'Finance & Accounts', icon: Wallet, text: 'Automated invoices, payments, vendor bills, wage runs and reconciled costs.' },
  { role: 'Buyer Portal', icon: ShoppingBag, text: 'Self-service ordering at fixed catalog prices and real-time shipment tracking.' },
];

const ORDER_STAGES = ['Review', 'Planned', 'Spinning', 'Weaving', 'Dyeing', 'Inspection', 'Truck'];

export function LandingPage() {
  const navigate = useNavigate();
  const anchorWord = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [reduced] = useState(reducedMotion);

  // The nav is transparent over the hero and becomes a frosted dark bar once you scroll past it.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    document.documentElement.classList.add('lp-root');
    return () => document.documentElement.classList.remove('lp-root');
  }, []);

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className={`landing ${reduced ? 'is-reduced' : ''}`}>
      <a className="lp-skip" href="#dashboard">Skip to content</a>
      <header className={`lp-nav ${scrolled ? 'is-scrolled' : ''}`}>
        <div className="lp-container lp-nav-inner">
          <Link to="/" className="lp-brand" aria-label="LoomOS home">
            <span className="lp-brand-mark"><Layers size={17} /></span>
            Loom<b>OS</b><i>.</i>
          </Link>
          <nav className="lp-nav-links" aria-label="Sections">
            <a href="#dashboard" onClick={go('dashboard')}>The dashboard</a>
            <a href="#flow" onClick={go('flow')}>How it works</a>
            <a href="#roles" onClick={go('roles')}>Roles</a>
            <a href="#buyers" onClick={go('buyers')}>Buyers</a>
          </nav>
          <div className="lp-nav-actions">
            <Link to="/login" className="lp-btn lp-btn-ghost">Sign in</Link>
            <Link to="/buyer/signup" className="lp-btn lp-btn-lime">Place an order <ArrowRight size={16} /></Link>
          </div>
        </div>
      </header>

      <section className="lp-hero" aria-labelledby="lp-title">
        <div ref={sentinel} className="lp-sentinel" aria-hidden="true" />
        <ThreadCanvas scrim="left" weaveX={0.74} anchor={anchorWord} />
        <div className="lp-grain" aria-hidden="true" />
        <div className="lp-container lp-hero-inner">
          <span className="lp-badge"><i /> Factory operating system<span className="lp-badge-more"> · Textile mills</span></span>
          <h1 id="lp-title" className="lp-h1">
            <span className="lp-line"><span>Every thread</span></span>
            <span className="lp-line"><span>of your mill,</span></span>
            <span className="lp-line"><span><em ref={anchorWord}>woven</em> into</span></span>
            <span className="lp-line"><span>one system.</span></span>
          </h1>
          <p className="lp-sub">
            LoomOS follows yarn from the gate to the truck: spinning, weaving and dyeing on real machines, every roll inspected,
            every shift paid, every order tracked by the buyer who placed it.
          </p>
          <div className="lp-cta-row">
            <Link to="/buyer/signup" className="lp-btn lp-btn-lime lp-btn-lg">Place an order <ArrowRight size={18} /></Link>
            <a href="#flow" onClick={go('flow')} className="lp-btn lp-btn-ghost lp-btn-lg">How it works</a>
          </div>

          <a href="#dashboard" onClick={go('dashboard')} className="lp-scroll-hint" aria-label="Scroll to the dashboard"><ArrowDown size={14} /> Yarn in</a>
        </div>
      </section>

      <div className="lp-ticker" aria-hidden="true">
        <div className="lp-ticker-track">
          {[0, 1].map((copy) => (
            <div className="lp-ticker-row" key={copy}>
              {STAGES.map((s) => <span key={s}><i />{s}</span>)}
            </div>
          ))}
        </div>
      </div>

      <section id="dashboard" className="lp-section lp-dashboard">
        <div className="lp-container">
          <Reveal className="lp-centre">
            <span className="lp-eyebrow">The overview</span>
            <h2 className="lp-h2">One screen for the whole mill.</h2>
            <p className="lp-lead">
              Whoever signs in gets five answers: what is running, what is waiting, what needs attention, what is done, what is late.
              The owner sees orders and money. The operator sees their machine. The inspector sees the oldest roll first.
            </p>
            <div className="lp-cta-row lp-centre-row">
              <Link to="/login" className="lp-btn lp-btn-dark lp-btn-lg">Sign in to workspace <ArrowRight size={18} /></Link>
              <a href="#flow" onClick={go('flow')} className="lp-btn lp-btn-outline lp-btn-lg">How it works</a>
            </div>
          </Reveal>
          <Reveal className="lp-frame-wrap">
            <svg className="lp-doodle" viewBox="0 0 120 120" aria-hidden="true">
              <path d="M60 8 L66 48 L104 54 L66 60 L60 100 L54 60 L16 54 L54 48 Z" fill="none" stroke="#111316" strokeWidth="3" strokeLinejoin="round" />
            </svg>
            <div className="lp-frame">
              <span className="lp-frame-chip">Live operations</span>
              <ScaledFrame width={1100} height={680}><DashboardMock /></ScaledFrame>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="flow" className="lp-section lp-flow">
        <div className="lp-container">
          <Reveal className="lp-heading-row">
            <div>
              <span className="lp-eyebrow">How it works</span>
              <h2 className="lp-h2">From the gate to the truck.</h2>
            </div>
            <p className="lp-lead">Every stage writes to the same record, so nobody re-types a batch number and nobody walks the floor to find a roll.</p>
          </Reveal>
          <Reveal className="lp-flow-grid">
            <svg className="lp-flow-thread" viewBox="0 0 1200 520" preserveAspectRatio="none" aria-hidden="true">
              <path d="M-20 262 C 260 226, 460 300, 700 256 S 1020 228, 1220 262" />
            </svg>
            {FLOW.map((f, i) => (
              <article key={f.n} className="lp-card lp-flow-card" style={{ transitionDelay: `${i * 80}ms` }}>
                <span className="lp-step"><f.icon size={18} /><b>{f.n}</b></span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </Reveal>
        </div>
      </section>

      <section id="roles" className="lp-section lp-roles">
        <div className="lp-container">
          <Reveal className="lp-heading-row">
            <div>
              <span className="lp-eyebrow">Workforce & Operations</span>
              <h2 className="lp-h2">Designed for everyone on your team.</h2>
            </div>
            <p className="lp-lead">Dedicated workspaces for each factory responsibility, from the mill owner to floor operators.</p>
          </Reveal>

          <Reveal className="lp-roles-grid">
            {ROLES.map((r, i) => (
              <div key={r.role} className={`lp-card lp-role ${r.dark ? 'is-dark' : ''}`} style={{ transitionDelay: `${i * 60}ms` }}>
                <span className="lp-role-icon"><r.icon size={18} /></span>
                <h3>{r.role}</h3>
                <p>{r.text}</p>
                <span className="lp-role-go"><Check size={14} /> Purpose-built workflow</span>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section id="buyers" className="lp-section lp-buyers">
        <div className="lp-grain" aria-hidden="true" />
        <div className="lp-container lp-buyers-grid">
          <Reveal>
            <span className="lp-eyebrow lp-eyebrow-lime">For buyers</span>
            <h2 className="lp-h2 lp-h2-light">Place an order. Watch it move.</h2>
            <p className="lp-lead lp-lead-light">
              Create a buyer account, send the fabric, colour and metres you need at the fixed price, and follow the order through spinning,
              weaving, dyeing and inspection to the truck. No phone calls to find out where it is.
            </p>
            <div className="lp-cta-row">
              <Link to="/buyer/signup" className="lp-btn lp-btn-lime lp-btn-lg">Create a buyer account <ArrowRight size={18} /></Link>
              <Link to="/login" className="lp-text-link">Already a buyer? Sign in</Link>
            </div>
          </Reveal>
          <Reveal className="lp-tracker" delay={150}>
            <div className="lp-tracker-head">
              <div><small>Order</small><strong>SO-2026-1042</strong></div>
              <div><small>Fabric</small><strong>Cotton twill · Indigo · 1,000 m</strong></div>
              <div><small>Delivery</small><strong>18 Oct</strong></div>
            </div>
            <ol className="lp-stages">
              {ORDER_STAGES.map((s, i) => (
                <li key={s} className={i < 4 ? 'is-done' : i === 4 ? 'is-now' : ''} style={{ transitionDelay: `${300 + i * 180}ms` }}>
                  <i /><span>{s}</span>
                </li>
              ))}
            </ol>
            <div className="lp-tracker-foot">
              <span className="lp-pill lp-pill-lime">Dyeing · 420 / 1,000 m</span>
              <span>Started 06:14 on DY-01 · on schedule</span>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="lp-section lp-principles">
        <div className="lp-container">
          <Reveal className="lp-heading-row">
            <div>
              <span className="lp-eyebrow">The rules we built in</span>
              <h2 className="lp-h2">Built for the shed, not the boardroom.</h2>
            </div>
          </Reveal>
          <Reveal className="lp-principles-grid">
            {[
              { icon: QrCode, title: 'Every roll carries a passport.', text: 'A label on every roll opens its history: batch, machine, operator, inspection result and the truck it left on.' },
              { icon: KeyRound, title: 'Every action has a permission.', text: 'Each change names one job. A supervisor can mark attendance and hand over a shift; they cannot approve an invoice.' },
              { icon: Smartphone, title: 'It works on the phone at the machine.', text: 'Operators start, pause and finish jobs from a phone. Inspectors scan labels with the camera. The owner closes the books from anywhere.' },
            ].map((p, i) => (
              <article key={p.title} className="lp-card lp-principle" style={{ transitionDelay: `${i * 90}ms` }}>
                <span className="lp-principle-icon"><p.icon size={22} /></span>
                <h3>{p.title}</h3>
                <p>{p.text}</p>
              </article>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="lp-section lp-final">
        <ThreadCanvas converge weaveX={0.55} seed={19} />
        <div className="lp-grain" aria-hidden="true" />
        <div className="lp-container lp-final-inner">
          <Reveal>
            <h2 className="lp-h2 lp-h2-light">Bring the whole mill into one system.</h2>
            <div className="lp-cta-row">
              <Link to="/buyer/signup" className="lp-btn lp-btn-lime lp-btn-lg">Place an order <ArrowRight size={18} /></Link>
              <Link to="/login" className="lp-btn lp-btn-ghost lp-btn-lg">Sign in</Link>
              <Link to="/signup" className="lp-text-link">Need a staff account? Request one</Link>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <div>
            <span className="lp-brand lp-brand-sm">Loom<b>OS</b><i>.</i></span>
            <small>Factory operating system · Everest Textile Mills, Ludhiana</small>
          </div>
          <nav aria-label="Footer">
            <a href="#flow" onClick={go('flow')}>How it works</a>
            <a href="#roles" onClick={go('roles')}>Roles</a>
            <Link to="/login">Sign in</Link>
            <Link to="/buyer/signup">Create a buyer account</Link>
            <Link to="/signup">Request a staff account</Link>
          </nav>
          <small>© 2026 LoomOS</small>
        </div>
      </footer>
      <button type="button" className="lp-fab" onClick={() => navigate('/login')} aria-label="Sign in"><UserRound size={16} /> Sign in</button>
    </div>
  );
}
