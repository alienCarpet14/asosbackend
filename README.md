app.js - backend for login and register API
ws.js - WS server for yjs


login and register api consumes JSON
{
"username": "username",
"password": "password"
}

run instructions:
1. edit port and IP in config.js - see configExample.js
2. edit database_credentials.js - see database_credentialsExample.js
3. install postgresql 
4. node ws.js
5. node app.js