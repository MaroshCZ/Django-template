Pokud chceš mít "klidné spaní", ohlídej si v settings.py a .env tyto tři body:

    DEBUG = False: Tohle je v produkci kritické. Pokud je True a stane se chyba, Django útočníkovi ukáže tvůj kód, proměnné i nastavení databáze.

    SECRET_KEY: Tohle nesmí být na GitHubu! Musí to být v .env souboru. Pokud ti někdo ukradne SECRET_KEY, může se podvrhnout přihlášení i bez hesla.

    Hlídání pokusů o přihlášení: Existují balíčky jako django-axes, které zablokují IP adresu po 3 špatných pokusech.