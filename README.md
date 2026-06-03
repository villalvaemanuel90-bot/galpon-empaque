# Sistema de Gestión — Galpón de Empaque

Sistema completo para gestión de galpones de empaque de frutos secos.

## Instalación

Ver guía de instalación paso a paso en el PDF adjunto.

## Variables de entorno requeridas

- `DATABASE_PATH` → `/app/data/galpon.db`
- `JWT_SECRET` → clave secreta larga
- `CEO_WHATSAPP` → número sin + (ej: 5492612345678)
- `CEO_PASSWORD` → contraseña inicial del CEO
- `META_VERIFY_TOKEN` → token para webhook de WhatsApp
- `META_ACCESS_TOKEN` → token de Meta Business
- `META_PHONE_NUMBER_ID` → ID del número de WhatsApp
- `ANTHROPIC_API_KEY` → clave de Anthropic para OCR
