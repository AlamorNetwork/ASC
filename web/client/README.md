# ASC — Research Workspace

این بسته شامل سورس فعلی پروژه Floot با شناسه `90746e4c-7973-4bdd-8c04-e5d99df20ac7` است. همه صفحه‌ها، کامپوننت‌ها، CSSها، helperها، فایل‌های تنظیمات پروژه و تصاویر استفاده‌شده در رابط کاربری داخل بسته قرار دارند.

## اجرای محلی

نیازمندی: Node.js 20 یا جدیدتر.

```bash
npm install
npm run dev
```

سپس آدرس `http://localhost:5173` را باز کنید.

برای ساخت نسخه نهایی:

```bash
npm run build
npm run preview
```

## مسیرهای اصلی

- `/` — لندینگ
- `/login` — ورود
- `/dossiers` — پرونده‌ها
- `/dashboard` — فضای پژوهش
- `/sources` — منابع
- `/agents` — عامل‌ها
- `/evidence` — شواهد
- `/settings` — تنظیمات

## یادداشت

فایل‌های `*.example.tsx` و `*.spec.tsx` نیز برای حفظ کامل سورس Floot داخل بسته هستند، اما از build اصلی کنار گذاشته شده‌اند چون exampleهای داخلی Floot به پکیج خصوصی `@floot/examples` وابسته‌اند. پوشه‌های تولیدشده مانند `node_modules`، `dist` و cacheها عمداً در ZIP نیستند.
