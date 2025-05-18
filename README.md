Luma Bot to register automatically to hundreds of luma event from a calendar or page, powered by AI

I first used chromium head browser but switched to full api requests to scrape and register events.
I only kept the login part on chromium to let the user login and get its cookies.

How to use

-   Git clone or download this repository
-   Install Google Chrome : https://www.google.com/chrome/
-   Install node.js : https://nodejs.org/en/download
-   In Profile.txt
    -   Fill your info
    -   Use n/a for fields you don't have
-   Go to https://console.groq.com/keys
    -   Create an account and get your GROQ API KEY
-   In config.txt file
    -   Set your GROQ API KEY
    -   Set the Luma Calendar link
    -   Set your browser (supported: chrome, brave, arc)
-   Run in your terminal the command : npm i

Configuration

-   In config.txt file:

```
GROQ_API_KEY: gsk_5q...
EVENT_CALENDAR_URL:https://lu.ma/your-calendar-url
BROWSER: chrome
```

-   Close Google Chrome completly
-   While being in this folder run in your terminal the command : npx ts-node src/api_flow/main_api.ts
-   On the page that opens, log in to your luma account then wait (You have 60 seconds to log in)
-   Enjoy !
