# BotFather setup

## 1. Command menu

Send `/setcommands` to [@BotFather](https://t.me/BotFather), pick the bot, then paste
**exactly** this block. One `command - description` per line, lowercase command, no
leading slash, no blank lines.

```
menu - منوی اصلی
use - انتخاب پرونده
close - خروج از گفتگو
watch - پیگیری خودکار پرونده
intentions - فهرست پیگیری‌ها
unwatch - توقف یک پیگیری
link - وصل کردن دو پرونده
unlink - برداشتن پیوند
related - پرونده‌های مرتبط
cost - گزارش هزینه
recent - آخرین ثبت‌ها
db - وضعیت داده‌ها
model - دیدن و تغییر مدل‌ها
models - فهرست مدل‌های موجود
budget - سقف هزینه‌ی هر تحقیق
users - مدیریت کاربران
```

`/sql`, `/c`, `/d` and `/eps` are deliberately left out — they take arguments and
would only clutter the menu. They still work when typed.

## 2. Description — shown before someone presses Start

`/setdescription`:

```
فکرهای نیمه‌کاره‌ات را اینجا بگذار. ویس بفرست، سند بده، و بگذار در پس‌زمینه جلو برود.
نتیجه در چهار ستون می‌آید: چه چیزی را واقعاً در منبع دیدم، کجا منابع اختلاف دارند، چه چیزی تأیید نشد، و چه چیزی حل‌نشده ماند.
```

## 3. About — shown on the profile

`/setabout` (max 120 characters):

```
دستیار پژوهشی. ویس و سند را می‌خواند، در پس‌زمینه تحقیق می‌کند، و تأییدشده را از تأییدنشده جدا می‌کند.
```

## 4. Settings worth changing

| BotFather command | Set to | Why |
|---|---|---|
| `/setjoingroups` | Disable | The bot is per-person; a group has no single principal |
| `/setprivacy` | Enable | It should not see group messages it was not addressed in |
| `/setinline` | Disable | Not used |

## 5. Picture

`/setuserpic` — anything. The menu identifies the bot in a chat list far more than
the name does.
