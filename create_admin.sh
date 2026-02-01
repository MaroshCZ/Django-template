#!/bin/bash

# Create Django superuser for admin access
echo "Creating Django superuser..."
docker-compose exec backend python manage.py createsuperuser

echo ""
echo "Done! You can proceed with:"
echo "   - Visit http://localhost:8000 for the hello world page"
echo "   - Visit http://localhost:8000/admin for the admin panel"
