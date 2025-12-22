# Инструкция по пересозданию репозитория

## Вариант 1: Полное пересоздание (рекомендуется)

```bash
# 1. Удали старый .git
rm -rf .git

# 2. Убедись что .env не будет добавлен
# (он уже в .gitignore, но проверь)

# 3. Создай новый репозиторий
git init
git add .
git commit -m "Initial commit: EUROZ monitor bot"

# 4. Подключи к GitHub (если нужно)
git remote add origin https://github.com/your-username/euroz-monitor.git
git branch -M main
git push -u origin main --force
```

## Вариант 2: Быстрый (если токен НЕ был в коммите)

```bash
# Проверь, есть ли .env в истории
git log --all --full-history -- .env

# Если вывод пустой - токен в безопасности, ничего делать не нужно!
```

## Вариант 3: Очистка истории (если токен УЖЕ в коммите)

```bash
# Удали .env из истории
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch .env" \
  --prune-empty --tag-name-filter cat -- --all

# Принудительно обнови remote
git push origin --force --all
```

## ⚠️ ВАЖНО: После любого варианта

1. Отзови старый токен через @BotFather:
   - Отправь `/mybots`
   - Выбери бота
   - Bot Settings → Revoke Token

2. Создай новый токен и обнови `.env`

3. Для Fly.io используй секреты:
   ```bash
   fly secrets set TELEGRAM_BOT_TOKEN=новый_токен
   ```
