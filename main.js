import express from 'express';
import setupStatusRoutes from './api/status.js';
import setupBrowserRoutes from './api/browser.js';

const app = express();
const PORT = 3000;

app.use(express.json());

setupStatusRoutes(app);
setupBrowserRoutes(app);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});