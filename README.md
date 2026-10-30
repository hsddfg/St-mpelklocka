# Stämpelklocka

En enkel stämpelklocka för mobilen. Stämpla in, gå på lunch och stämpla ut – antingen genom att
skanna en QR-kod, hålla telefonen mot en NFC-klisterlapp eller med en knapp i appen.

Appen är en så kallad PWA (webbapp som installeras på hemskärmen). Den fungerar på **Android**
och **iPhone**, fungerar offline och kräver ingen inloggning eller server – alla stämplingar
sparas bara på din egen telefon.

## Funktioner

- **Stora knappar** som ändras efter läget: *Kom in* → *Lunch / Gå hem* → *Tillbaka / Gå hem*.
- **QR-koder** att skriva ut (fliken *QR-koder*):
  - **Kom till jobbet** – stämplar in (eller avslutar lunchen om du är på lunch).
  - **Lunch** – växlar mellan lunch början och lunch slut.
  - **Gå hem** – stämplar ut.
  - **Stämpla** – en enda kod för allt; appen frågar *Lunch eller Gå hem?* när det behövs.
- QR-koderna kan skannas med **appens egen skanner** eller med **telefonens vanliga kamera**.
- **NFC-lappar**: samma fyra koder kan skrivas till NFC-klisterlappar. Håll telefonen mot lappen
  så stämplas du – även när appen är stängd.
- Skydd mot dubbelskanning (samma stämpling inom 2 minuter ignoreras).
- **Idag**: status, arbetad tid, lunchtid och veckans totala tid.
- **Historik** per vecka och dag. Tryck på en stämpling för att ändra eller ta bort den,
  eller lägg till en du glömt. Dagar där du glömt stämpla ut markeras med ⚠️.
- **Aktiviteter**: dela upp dagen, t.ex. *Klinik* och *Forskning*. Välj aktivitet med reglaget
  ovanför knapparna – är du instämplad byter du direkt. Varje aktivitet får också en egen
  QR-kod/NFC-lapp som stämplar in på, eller byter till, aktiviteten. Aktiviteterna ändras under *Mer*.
- **Flex mot schema**: arbetad tid jämförs med ditt schema (förinställt mån–tor 8–17,
  fre 8–15.45, 45 min lunch – ändras under *Mer*). Visas idag, per dag och per vecka.
  Dagar utan stämplingar (ledighet, röda dagar) räknas inte.
- **Rapport via e-post**: välj period och tryck *Skicka e-post* – mejlappen öppnas med en färdig
  sammanfattning (arbetad tid, schema, flex, fördelning per aktivitet och per dag) till den
  adress du angett. Finns även *Dela…* och CSV-export (Excel/Google Kalkylark).
- **Säkerhetskopia** som JSON.

## Kom igång

### 1. Publicera appen

Appen måste ligga på en https-adress för att kameran och installationen ska fungera.
Enklast är GitHub Pages (ingår i repot):

1. Slå ihop koden till `main`.
2. Gå till repots **Settings → Pages** och välj **Source: GitHub Actions**.
3. Efter någon minut finns appen på `https://<användarnamn>.github.io/<repo>/`.

(Alla statiska webbhotell fungerar, t.ex. Netlify eller Cloudflare Pages – det är bara vanliga filer.)

### 2. Installera på telefonen

- **Android (Chrome):** öppna adressen → menyn ⋮ → *Installera app* / *Lägg till på startskärmen*.
- **iPhone (Safari):** öppna adressen → Dela-knappen → *Lägg till på hemskärmen*.

### 3. Skriv ut QR-koderna

Öppna fliken **QR-koder** i appen (på den publicerade adressen) och tryck *Skriv ut*.
Sätt t.ex. *Kom till jobbet* / *Gå hem* vid entrén och *Lunch* i lunchrummet.

### 4. NFC-lappar (valfritt)

Köp NFC-klisterlappar av typen **NTAG213** eller **NTAG215** (finns billigt på t.ex. Kjell,
Amazon eller AliExpress). Sedan:

- **Android (Chrome):** öppna fliken **Koder**, tryck *Skriv till NFC-lapp* under önskad kod och
  håll telefonen mot lappen. Klart.
- **Annan telefon/webbläsare:** tryck *Kopiera NFC-länk* och skriv länken till lappen med en
  gratis app som *NFC Tools* (välj *Skriv → Lägg till post → URL*).

Att tänka på:

- Telefonen måste vara **upplåst** och ha **NFC påslaget** för att läsa lappen.
- Slå gärna på **Läs NFC-lappar direkt i appen** under *Mer* (Android). Då stämplar appen direkt
  när den är öppen, i stället för att Android öppnar länken i webbläsaren.
- Lås gärna lappen (skrivskydd) i *NFC Tools* när den sitter uppe, så att ingen kan skriva över den.
- Sitter lappen på en metalldörr kan den behöva en "on-metal"-variant för att läsas.

## Bra att veta

- **iPhone:** en app som lagts på hemskärmen har egen lagring, skild från Safari. Skanna därför
  med **appens skanner-knapp** på iPhone. Skannar du med vanliga kameran öppnas länken i Safari
  och stämplingen hamnar där i stället. Samma sak gäller NFC-lappar på iPhone (de öppnas alltid
  i Safari). Vill du använda NFC på iPhone, använd då appen i Safari i stället för från
  hemskärmen. På Android spelar det ingen roll.
- Data finns bara på telefonen. Ta en säkerhetskopia (fliken *Mer*) ibland och innan du byter telefon.
- Vill du testa lokalt: `python3 -m http.server` i mappen och öppna `http://localhost:8000`.

## Filer

| Fil | Innehåll |
| --- | --- |
| `index.html` | Sidan och alla vyer |
| `css/style.css` | Utseende (ljust och mörkt läge) |
| `js/app.js` | All logik: stämpling, beräkning, skanner, export |
| `sw.js` | Service worker för offline-läge |
| `vendor/` | [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0, läser QR) och [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT, skapar QR) |
