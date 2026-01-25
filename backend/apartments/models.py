from django.db import models
from django.utils import timezone

# 1. Číselník městských částí (z toho tvého "istriktu" jsonu)
class District(models.Model):
    name = models.CharField(max_length=100, unique=True) # např. "Praha 1 - Staré město"
    city_part = models.CharField(max_length=50, blank=True) # "Praha 1"
    neighborhood = models.CharField(max_length=50, blank=True) # "Staré město"
    
    def __str__(self):
        return self.name

# 2. Cache adres a ulic (z toho "adress" jsonu)
# Tohle bude sloužit jako "slovník", aby scraper nemusel furt volat Google API
class StreetLocation(models.Model):
    street_name = models.CharField(max_length=255, db_index=True) # Index pro rychlé hledání!
    lat = models.FloatField()
    lng = models.FloatField()
    
    # Další metadata, co tam máš
    full_address = models.CharField(max_length=500, blank=True)
    postal_code = models.CharField(max_length=20, blank=True)
    district_link = models.ForeignKey(District, on_delete=models.SET_NULL, null=True, blank=True)

    class Meta:
        unique_together = ('street_name', 'postal_code') # Aby se neukládaly duplicity

    def __str__(self):
        return f"{self.street_name} ({self.lat}, {self.lng})"

# 3. Hlavní model pro byty
"""
obj, created = Apartment.objects.update_or_create(
    remote_id=data['id'], # Klíč pro hledání existence
    defaults={
        'scraper': data['scraper'],
        'link': data['link'],
        'title': data['title'],
        'price': data['price'],
        'city_part': data['city_part'], # Praha 5
        'lat': data['lat'],
        'lng': data['lng'],
        'last_ping_is_valid': data['last_ping_is_valid'],
        # ... a zbytek polí
    }
)
"""
class Apartment(models.Model):
    # --- Identifikace ---
    # Unikátní ID ze scraperu (z tvého JSONu "id")
    remote_id = models.CharField(max_length=100, unique=True, db_index=True) 
    scraper = models.CharField(max_length=50, db_index=True) # "UlovDomov"
    link = models.URLField(max_length=500, unique=True) # Pojistka proti duplicitám

    # --- Hlavní data ---
    title = models.CharField(max_length=255) # "Byt 1+1, 35 m²"
    description = models.TextField(blank=True, null=True)
    
    # 💰 Price: Integer stačí (nájmy jsou celá čísla), ale pro DB čistotu můžeš Decimal
    price = models.IntegerField(db_index=True) # 20000
    
    # 🖼️ Obrázky
    image_url = models.URLField(max_length=500, blank=True, null=True)

    # --- Parsovaná data (To co chceme vytáhnout z Title/Popisu) ---
    # Doporučuji tato pole přidat, i když v JSONu nejsou přímo. 
    # Kolega je při ukládání "vyparsuje" z title.
    disposition = models.CharField(max_length=20, blank=True, null=True) # "1+1"
    area = models.IntegerField(blank=True, null=True) # 35 (jen číslo)

    # --- Lokace (Denormalizovaná pro rychlost) ---
    # Zde ukládáme raw data z inzerátu
    # Default je Praha, ale scraper tam může poslat "Brno"
    address = models.CharField(max_length=500, blank=True, null=True) # "Křížová, Smíchov, Praha, obvod Praha 5, Hlavní město Praha, Praha, 150 21, Česko"
    city = models.CharField(max_length=50, default='Praha', db_index=True) # "Praha"
    city_part = models.CharField(max_length=100, blank=True, null=True, db_index=True) # "Praha 5"
    district = models.CharField(max_length=100, blank=True, null=True) # "Praha"
    street_name = models.CharField(max_length=255, blank=True, null=True) # "Křížová"
    region = models.CharField(max_length=100, blank=True, null=True) # "obvod Praha 5"
    country = models.CharField(max_length=50, default='Česko', blank=True, null=True) # "Česko"
    postal_code = models.CharField(max_length=20, blank=True, null=True) # "150 21" (Text, ne číslo!)
    
    # Geo souřadnice (Float pro začátek stačí, PostGIS je upgrade)
    lat = models.FloatField(blank=True, null=True)
    lng = models.FloatField(blank=True, null=True)

    # --- Scraper Metadata & Monitoring ---
    created_at = models.DateTimeField(default=timezone.now) # Kdy jsme to našli my
    updated_at = models.DateTimeField(auto_now=True) # Kdy se změnil záznam u nás
    
    # Ping status (z tvého JSONu)
    last_ping = models.DateTimeField(blank=True, null=True)
    last_ping_status = models.IntegerField(blank=True, null=True) # 200
    last_ping_is_valid = models.BooleanField(default=True, db_index=True) # true
    
    # Pro debugování
    batch_number = models.IntegerField(blank=True, null=True)

    class Meta:
        ordering = ['-created_at']
        unique_together = ('scraper', 'remote_id')
        indexes = [
            # Kompozitní index pro nejčastější dotaz: "Aktivní byty v Praze 5 seřazené cenou"
            models.Index(fields=['city', 'city_part', 'price', 'last_ping_is_valid']),
        ]

    def __str__(self):
        return f"{self.title} ({self.price} Kč)"