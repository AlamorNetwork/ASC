import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { User, BrainCircuit, Search, Coins, ShieldCheck, Database, KeyRound, ChevronLeft, LogOut } from "lucide-react";
import WorkspaceShell from "../components/WorkspaceShell";
import { useSession } from "../contexts/SessionContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import styles from "./settings.module.css";

const sections = [
  { key: "profile", label: "حساب و پروفایل", icon: User },
  { key: "models", label: "مدل‌ها و عامل‌ها", icon: BrainCircuit },
  { key: "research", label: "وضعیت پژوهش", icon: Search },
  { key: "cost", label: "هزینه", icon: Coins },
  { key: "privacy", label: "حریم خصوصی", icon: ShieldCheck },
  { key: "storage", label: "داده و ذخیره‌سازی", icon: Database },
  { key: "api", label: "اتصال‌ها و API", icon: KeyRound },
] as const;

export default function SettingsPage() {
  const navigate = useNavigate();
  const { session, logout } = useSession();
  const { state } = useWorkspace();
  const [active, setActive] = useState<typeof sections[number]["key"]>("profile");
  const section = sections.find((item) => item.key === active)!;
  const Icon = section.icon;
  const user = session?.user;

  const content: Record<typeof sections[number]["key"], { title: string; lines: Array<[string, string]> }> = {
    profile: { title: "نشست و حساب", lines: [["نام", user?.displayName || "حساب قدیمی"], ["ایمیل", user?.email || "ورود با رمز مالک"], ["نوع حساب", user?.legacy ? "مسیر سازگاری قدیمی" : "حساب مستقل"]] },
    models: { title: "مدل‌ها و عامل‌ها", lines: [["تنظیم مدل‌ها", "از فایل محیطی سرور و فرمان‌های مدیریت مدل خوانده می‌شود"], ["عامل‌های پرونده فعال", String(state?.researchNodes.length || 0)], ["وضعیت", "کلیدها و نام ارائه‌دهنده در مرورگر افشا نمی‌شوند"]] },
    research: { title: "پژوهش فعال", lines: [["پرونده", state?.selected?.topic || "پرونده‌ای انتخاب نشده"], ["نیت‌های پژوهشی", String(state?.researchNodes.length || 0)], ["کاوش عمیق", state?.investigation?.state || "در حال اجرا نیست"]] },
    cost: { title: "هزینهٔ ثبت‌شده", lines: [["هزینهٔ کاوش فعال", `${Number(state?.investigation?.costToman || 0).toLocaleString("fa-IR")} تومان`], ["هزینه دلاری", `$${Number(state?.investigation?.costUsd || 0).toFixed(4)}`], ["کنترل سقف", "هنگام شروع کاوش عمیق از کاربر تأیید گرفته می‌شود"]] },
    privacy: { title: "مرزبندی داده", lines: [["دامنه", "تمام خواندن‌ها با شناسهٔ صاحب حساب محدود می‌شوند"], ["نشست", "توکن نشست به‌صورت HttpOnly نگه‌داری می‌شود"], ["اصل فایل", "فقط وقتی روی همین سرور موجود باشد قابل دانلود است"]] },
    storage: { title: "داده‌های واقعی", lines: [["پرونده‌ها", String(state?.dossiers.length || 0)], ["اسناد پرونده فعال", String(state?.documents.length || 0)], ["ادعاهای پرونده فعال", String(state?.claims.length || 0)]] },
    api: { title: "اتصال‌های سرور", lines: [["مدل‌ها", "کلیدها فقط در محیط سرور نگه‌داری می‌شوند"], ["Google OCR", state?.googleOcrReady ? "آماده" : "پیکربندی نشده"], ["API مرورگر", "فقط مسیرهای same-origin و نشست احراز هویت‌شده"]] },
  };

  return <WorkspaceShell active="settings" title="تنظیمات" subtitle="اطلاعات واقعی حساب، ذخیره‌سازی و اتصال‌های همین نشست.">
    <div className={styles.layout}><aside className={styles.menu}>{sections.map((item) => { const ItemIcon = item.icon; return <button key={item.key} onClick={() => setActive(item.key)} className={active === item.key ? styles.active : ""}><ItemIcon/><span>{item.label}</span><ChevronLeft/></button>; })}</aside>
      <section className={styles.panel}><header><div className={styles.icon}><Icon/></div><div><h2>{section.label}</h2><p>این صفحه فقط داده‌ای را نشان می‌دهد که بک‌اند ASC واقعاً در اختیار مرورگر گذاشته است.</p></div></header>
        <div className={styles.models}><h3>{content[active].title}</h3>{content[active].lines.map(([label, value]) => <div key={label}><span><b>{label}</b><small>{value}</small></span></div>)}</div>
        <footer><button className={styles.save} onClick={async () => { await logout(); navigate("/", { replace: true }); }}><LogOut/> خروج امن</button>{state?.selected && <a className={styles.reset} href={`/api/ledger?dossierId=${state.selected.id}`}>دریافت دفتر پژوهش</a>}</footer>
      </section>
    </div>
  </WorkspaceShell>;
}
