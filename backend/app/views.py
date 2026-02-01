from django.shortcuts import render
from django.http import JsonResponse, StreamingHttpResponse
from .models import Apartment, District
import json
import time


def home(request):
    """Homepage"""
    return render(request, 'home.html')
