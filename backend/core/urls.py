"""
URL configuration for core project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path
from apartments import views

from apartments import views

urlpatterns = [
    path('admin/', admin.site.urls),
    
    # Pages
    path('', views.home, name='home'),
    path('apartments/', views.apartment_list, name='apartment_list'),
    
    # API Endpoints
    path('api/offers', views.api_offers, name='api_offers'),
    path('api/offers-map', views.api_offers_map, name='api_offers_map'),
    path('api/districts', views.api_districts, name='api_districts'),
    path('api/settings', views.api_settings, name='api_settings'),
    path('api/status', views.api_status, name='api_status'),
    path('api/stream', views.api_stream, name='api_stream'),
]
