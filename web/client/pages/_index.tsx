import { Link } from "react-router-dom";
import {
  ArrowLeft, Mic, Database, Network, ShieldCheck, Clock3,
  BookOpenText, FileSearch, Map, GitBranch, CheckCircle2, CircleHelp,
  TriangleAlert, LockKeyhole, Coins, Sparkles, Search
} from "lucide-react";
import styles from "./_index.module.css";

const dashboardImg="/landing-assets/dashboard-overview-1600x1000.png";
const ruinsImg="/landing-assets/hero-atlas-1920x1080.jpg";
const libraryImg="/landing-assets/feature-source-library-1200x675.jpg";
const voiceImg="/landing-assets/workflow-capture-1200x675.jpg";
const privacyImg="/landing-assets/privacy-local-system-1600x900.jpg";
const ctaImg="/landing-assets/cta-ruins-1920x640.jpg";
const featureImages=[
  "/landing-assets/feature-evidence-board-1200x675.jpg",
  "/landing-assets/feature-agent-tree-1200x675.jpg",
  "/landing-assets/feature-mother-agent-1200x675.jpg",
  "/landing-assets/feature-source-library-1200x675.jpg",
];

const features=[
  {icon:FileSearch,title:"گزارش‌های پژوهشی",text:"خروجی ساختاریافته با استناد و وضعیت اعتبار هر ادعا."},
  {icon:Map,title:"نقشه‌برداری دانش",text:"دیدن ارتباط میان افراد، مفاهیم، منابع و رخدادها."},
  {icon:GitBranch,title:"تحلیل و مقایسه",text:"مقایسه دیدگاه‌ها و پیدا کردن الگوها و شکاف‌های پنهان."},
  {icon:Database,title:"کاوش در منابع",text:"کتاب، مقاله، وب و اسناد محلی در یک فضای پژوهشی."},
];

const states=[
  {icon:CheckCircle2,title:"تأییدشده",num:"۶",className:"verified",text:"نقل‌قول در منبع پیدا شده و از ادعا پشتیبانی می‌کند."},
  {icon:Clock3,title:"بررسی‌شده",num:"۵",className:"reviewed",text:"شواهد وجود دارد، اما هنوز برای نتیجه قطعی کافی نیست."},
  {icon:TriangleAlert,title:"مورد اختلاف",num:"۳",className:"disputed",text:"منابع معتبر یا تفسیرهای مهم با یکدیگر اختلاف دارند."},
  {icon:CircleHelp,title:"پرسش‌های باز",num:"۴",className:"open",text:"هنوز پاسخ مستند و قابل اتکایی برای آن پیدا نشده است."},
];

export default function LandingPage(){
  return <main className={styles.page} dir="rtl">
    <header className={styles.nav}>
      <Link to="/" className={styles.logo}><span aria-hidden="true">✦</span> ASC</Link>
      <nav>
        <a href="#product">محصول</a><a href="#how">روش کار</a><a href="#features">قابلیت‌ها</a><a href="#evidence">شواهد</a><a href="#trust">امنیت</a>
      </nav>
      <div className={styles.navActions}><Link to="/login" className={styles.loginBtn}>ورود</Link><Link to="/dossiers" className={styles.goldBtn}>شروع یک پروژه <ArrowLeft size={16}/></Link></div>
    </header>

    <section className={styles.hero} id="product">
      <div className={styles.heroBackdrop} style={{backgroundImage:`linear-gradient(90deg,rgba(3,12,9,.98) 8%,rgba(3,12,9,.44),rgba(3,12,9,.7)),url(${ruinsImg})`}}/>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}><Sparkles size={15}/> پژوهش چندعاملی، فارسی‌محور و مستند</span>
        <h1>فکرت را نیمه‌کاره رها کن؛<br/><em>ASC</em> آن را جلو می‌برد.</h1>
        <p>یادداشت، صدا یا سند را بفرست؛ ASC مسیر پژوهش و شاهدهای قابل‌ردیابی را آماده می‌کند.</p>
        <div className={styles.heroActions}><Link to="/dossiers" className={styles.goldBtn}>شروع یک پروژه <ArrowLeft size={17}/></Link><a className={styles.ghostBtn} href="#how">دیدن روش کار</a></div>
        <div className={styles.heroNotes}><span><Network size={16}/> تیم عامل‌های تخصصی</span><span><ShieldCheck size={16}/> شواهد قابل‌ردیابی</span><span><Coins size={16}/> کنترل هزینه</span></div>
      </div>
      <div className={styles.previewWrap}>
        <div className={styles.previewChrome}><i/><i/><i/><span>ASC Research Workspace</span></div>
        <img src={dashboardImg} alt="ASC dashboard preview"/>
      </div>
    </section>

    <section className={styles.trustStrip}>
      <div><Network/><span><b>چندعامل هوشمند</b><small>همکاری مثل یک تیم پژوهشی</small></span></div>
      <div><Clock3/><span><b>صرفه‌جویی در زمان</b><small>پژوهش در پس‌زمینه</small></span></div>
      <div><Database/><span><b>منابع متنوع</b><small>وب، کتاب، مقاله و PDF</small></span></div>
      <div><ShieldCheck/><span><b>قابل‌ردیابی</b><small>هر ادعا با منبع خودش</small></span></div>
    </section>

    <section className={styles.section} id="how">
      <div className={styles.sectionHead}><span>WORKFLOW</span><h2>در سه گام، پژوهش را به جریان بیندازید</h2><p>از یک فکر خام تا نتیجه‌ای مستند، ASC مسیر را نگه می‌دارد.</p></div>
      <div className={styles.steps}>
        <article><b>۱</b><Mic/><h3>ثبت ایده</h3><p>با صدا یا متن، سؤال یا موضوع را همان‌طور که در ذهن داری ثبت کن.</p></article>
        <article><b>۲</b><Network/><h3>پژوهش در پس‌زمینه</h3><p>عامل‌های تخصصی منابع را می‌خوانند، مقایسه می‌کنند و شکاف‌ها را پیدا می‌کنند.</p></article>
        <article><b>۳</b><BookOpenText/><h3>دریافت نتیجه</h3><p>یافته‌ها، ادعاها، اختلاف‌ها و پرسش‌های باز را جدا و روشن تحویل بگیر.</p></article>
      </div>
      <div className={styles.illustrationBand}><img src={voiceImg} alt="voice capture"/><div><span>CAPTURE → RESEARCH → EVIDENCE</span><h3>ورودی ساده، جریان پژوهش عمیق</h3><p>ASC بین ایده اولیه و نتیجه نهایی یک دفتر پژوهش زنده می‌سازد.</p></div></div>
    </section>

    <section className={styles.section} id="features">
      <div className={styles.sectionHead}><span>CORE CAPABILITIES</span><h2>قابلیت‌های اصلی ASC</h2><p>یک فضای پژوهشی یکپارچه برای ذهن کنجکاو.</p></div>
      <div className={styles.featureGrid}>{features.map((f,i)=>{const I=f.icon;return <article key={f.title}><div className={styles.featureImage} style={{backgroundImage:`linear-gradient(180deg,transparent,rgba(3,12,9,.9)),url(${featureImages[i]})`}}/><div><I/><h3>{f.title}</h3><p>{f.text}</p><Link to={i===0?"/evidence":i===1?"/agents":i===3?"/sources":"/dashboard"}>باز کردن در Workspace <ArrowLeft size={14}/></Link></div></article>})}</div>
    </section>

    <section className={styles.evidenceSection} id="evidence">
      <div className={styles.sectionHead}><span>EVIDENCE MODEL</span><h2>هر یافته، جایگاه خودش را دارد</h2><p>ASC یافته‌ها را با میزان دانسته‌شدن آن‌ها نمایش می‌دهد، نه با لحن مطمئن و یکدست.</p></div>
      <div className={styles.stateGrid}>{states.map(s=>{const I=s.icon;return <article key={s.title} className={styles[s.className]}><header><I/><h3>{s.title}</h3><b>{s.num}</b></header><p>{s.text}</p><button>نمونه‌ها را ببینید <ArrowLeft size={14}/></button></article>})}</div>
    </section>

    <section className={styles.trustSection} id="trust" style={{backgroundImage:`linear-gradient(90deg,rgba(3,12,9,.97),rgba(3,12,9,.7)),url(${privacyImg})`}}>
      <div><span className={styles.kicker}>TRUSTED RESEARCH INFRASTRUCTURE</span><h2>زیرساخت قابل اعتماد، برای پژوهش‌های جدی</h2><p>حریم خصوصی، کنترل هزینه، مسیر قابل‌ردیابی و نگهداری منظم منابع؛ همه در یک Workspace.</p></div>
      <div className={styles.trustCards}><article><LockKeyhole/><h3>حریم خصوصی</h3><p>داده‌ها و پرونده‌های پژوهشی به‌صورت جدا و کنترل‌شده نگه‌داری می‌شوند.</p></article><article><Coins/><h3>کنترل هزینه</h3><p>هزینه پژوهش و مصرف مدل‌ها شفاف و قابل بررسی است.</p></article><article><Search/><h3>قابل بازبینی</h3><p>هر ادعا، منبع و مرحله پژوهش قابل برگشت و مرور است.</p></article></div>
    </section>

    <section className={styles.cta} style={{backgroundImage:`linear-gradient(rgba(3,12,9,.42),rgba(3,12,9,.72)),url(${ctaImg})`}}>
      <h2>پژوهش عمیق، حالا در دسترس شماست.</h2><p>ایده‌هایت را به دانش مستند تبدیل کن.</p><Link to="/dossiers" className={styles.goldBtn}>ورود به ASC <ArrowLeft size={16}/></Link>
    </section>
    <footer className={styles.footer}><div className={styles.logo}><span>✦</span> ASC</div><span>ALAMOR NETWORK · PRIVATE RESEARCH WORKSPACE</span><span>© 2026 ASC</span></footer>
  </main>
}
