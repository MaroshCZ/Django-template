## 🚀 Quick Start

### 1. Preparation
```bash
git clone [url]
```

### 2. Start the Application
```bash
docker-compose up --build
```


### 3. Create Admin User
After starting the containers, open a new terminal and run:
```bash
./create_admin.sh
```
Enter the username, email, and password for access to the admin panel.

### 4. Access the Application
- **Homepage (Hello World):** http://localhost:8000
- **Admin panel:** http://localhost:8000/admin

---

---

## 🛠️ Frontend & Technologies

- **Tailwind CSS**: Managed by the `django-tailwind-cli` package. Detailed configuration in `backend/core/settings.py`. More info on [GitHub](https://github.com/django-commons/django-tailwind-cli)
- **JavaScript libraries**:
  - Manually installed in the `backend/static/js/vendor/` folder:
    - **HTMX** (minified)
    - **Alpine.js** (minified)

## 📂 Static Files

- **`backend/static/`**: Folder for your own files (CSS, images, JS). Make your edits here.
- **`backend/staticfiles/`**: Generated folder for production. **Do not edit manually!**
  - Contains collected files from your `static/` folder and from Django apps (e.g., Admin panel).
  - Generated with the command `python manage.py collectstatic`.
  - Required for proper operation in Docker/production.
