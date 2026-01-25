from django.shortcuts import render


def home(request):
    """Simple hello world homepage"""
    return render(request, 'home.html')

from django.shortcuts import render
from django.http import JsonResponse, StreamingHttpResponse
from .models import Apartment, District
import json
import time


def home(request):
    """Homepage"""
    return render(request, 'home.html')


def apartment_list(request):
    """Hlavní stránka - použije HTML z demo"""
    return render(request, 'apartment_list.html')


# ===== API Endpoints =====

def api_offers(request):
    """API endpoint - vrací JSON s nabídkami (s filtrováním)"""
    page = int(request.GET.get('page', 1))
    limit = int(request.GET.get('limit', 50))
    district = request.GET.get('district', '')
    
    offers_query = Apartment.objects.filter(last_ping_is_valid=True)
    
    if district:
        offers_query = offers_query.filter(city_part__icontains=district)
    
    total_count = offers_query.count()
    offers = offers_query[(page-1)*limit:page*limit]
    
    return JsonResponse({
        'offers': [
            {
                'id': apt.remote_id,
                'title': apt.title,
                'price': apt.price,
                'address': apt.address,
                'city_part': apt.city_part,
                'disposition': apt.disposition,
                'area': apt.area,
                'link': apt.link,
                'image_url': apt.image_url,
                'scraper': apt.scraper,
                'lat': apt.lat,
                'lng': apt.lng,
                'created_at': apt.created_at.isoformat(),
                'last_ping_is_valid': apt.last_ping_is_valid,
            }
            for apt in offers
        ],
        'pagination': {
            'page': page,
            'limit': limit,
            'total_count': total_count,
            'total_pages': (total_count + limit - 1) // limit,
            'has_next': page * limit < total_count,
            'has_prev': page > 1,
        }
    })


def api_offers_map(request):
    """Všechny nabídky pro mapu"""
    offers = Apartment.objects.filter(
        last_ping_is_valid=True,
        lat__isnull=False,
        lng__isnull=False
    )
    
    return JsonResponse({
        'offers': [
            {
                'id': apt.remote_id,
                'title': apt.title,
                'price': apt.price,
                'lat': apt.lat,
                'lng': apt.lng,
                'link': apt.link,
                'scraper': apt.scraper,
            }
            for apt in offers
        ]
    })


def api_districts(request):
    """Seznam městských částí"""
    districts = District.objects.all().values('name', 'city_part')
    return JsonResponse({'districts': list(districts)})


def api_settings(request):
    """Nastavení aplikace (placeholder)"""
    return JsonResponse({
        'scraping_enabled': False,
        'ping_enabled': False,
    })


def api_status(request):
    """Status scrapování (placeholder)"""
    return JsonResponse({
        'status': 'idle',
        'scraping': False,
        'pinging': False,
        'user_start_choice': '1',  # Rychlý start
        'total_offers': Apartment.objects.count(),
    })


def api_stream(request):
    """SSE Stream (placeholder - zatím neimplementováno)"""
    def event_stream():
        while True:
            # TODO: Implementovat real-time updates
            time.sleep(30)
            yield f"data: {json.dumps({'type': 'ping'})}\n\n"
    
    response = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response