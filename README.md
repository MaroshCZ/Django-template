## 🚀 Rychlý start

### 1. Příprava
```bash
git clone [url]
cp .env.example .env
```

### 2. Spuštění aplikace
```bash
docker-compose up --build
```

### 3. Vytvoření admin uživatele
Po spuštění kontejnerů otevřete nový terminál a spusťte:
```bash
./create_admin.sh
```
Zadejte uživatelské jméno, email a heslo pro přístup do admin panelu.

### 4. Přístup k aplikaci
- **Homepage (Hello World):** http://localhost:8000
- **Admin panel:** http://localhost:8000/admin

---

## 📝 Co bylo aktualizováno

### Dockerfile
- ✅ Bezpečnostní vylepšení (non-root user)
- ✅ Optimalizace build cache
- ✅ Upgrade pip

### Docker Compose
- ✅ Přidán command pro automatické migrace
- ✅ Automatické collect static files

### Django
- ✅ Jednoduchá hello world stránka s CSS
- ✅ Funkční admin panel
- ✅ Správně nakonfigurované ALLOWED_HOSTS
- ✅ Přidána apartments aplikace do INSTALLED_APPS