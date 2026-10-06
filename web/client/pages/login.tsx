import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Mail, LockKeyhole, ArrowLeft, ShieldCheck, UserRound } from "lucide-react";
import { useSession } from "../contexts/SessionContext";
import styles from "./login.module.css";

const bg = "/landing-assets/hero-atlas-1920x1080.jpg";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, login, signup } = useSession();
  const [mode, setMode] = useState<"login" | "signup" | "legacy">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from || "/dashboard";

  useEffect(() => { if (session) navigate(from, { replace: true }); }, [session, navigate, from]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "signup") await signup({ displayName: displayName.trim(), email: email.trim(), password });
      else if (mode === "legacy") await login({ password });
      else await login({ email: email.trim(), password });
      navigate(from, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ورود انجام نشد.");
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.page} dir="rtl" style={{ backgroundImage: `linear-gradient(90deg,rgba(3,12,9,.96),rgba(3,12,9,.68)),url(${bg})` }}>
    <Link to="/" className={styles.logo}><span aria-hidden="true">✦</span> ASC</Link>
    <section className={styles.card} aria-labelledby="auth-title">
      <span className={styles.kicker}>PRIVATE RESEARCH WORKSPACE</span>
      <h1 id="auth-title">{mode === "signup" ? "ساخت حساب پژوهشی" : "ورود به ASC"}</h1>
      <p>{mode === "signup" ? "پرونده‌ها و منابع هر حساب کاملاً جدا نگه‌داری می‌شوند." : "به پرونده‌ها، منابع و عامل‌های پژوهشی خودت برگرد."}</p>
      <div className={styles.tabs} role="group" aria-label="روش ورود">
        <button type="button" aria-pressed={mode === "login"} onClick={() => setMode("login")}>ورود</button>
        <button type="button" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>ساخت حساب</button>
        <button type="button" aria-pressed={mode === "legacy"} onClick={() => setMode("legacy")}>رمز قدیمی</button>
      </div>
      <form onSubmit={submit} noValidate>
        {mode === "signup" && <label htmlFor="signup-name"><span>نام نمایشی</span><div><UserRound aria-hidden="true"/><input id="signup-name" name="name" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></div></label>}
        {mode !== "legacy" && <label htmlFor="auth-email"><span>ایمیل</span><div><Mail aria-hidden="true"/><input id="auth-email" name="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required /></div></label>}
        <label htmlFor="auth-password"><span>رمز عبور</span><div><LockKeyhole aria-hidden="true"/><input id="auth-password" name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={mode === "legacy" ? undefined : 12} required /></div></label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button className={styles.submit} type="submit" disabled={busy}>
          {busy ? "در حال بررسی…" : mode === "signup" ? "ساخت حساب و ورود" : "ورود به Workspace"}<ArrowLeft aria-hidden="true"/>
        </button>
      </form>
      <div className={styles.secure}><ShieldCheck aria-hidden="true"/><span><b>محیط خصوصی و اصلی ASC</b><small>این فرم مستقیماً به احراز هویت و نشست امن سرور متصل است.</small></span></div>
    </section>
  </main>;
}
