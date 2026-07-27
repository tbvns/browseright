import express from 'express';
import setupStatusRoutes from './api/status.js';
import { setupEmbeddedBrowserRoutes } from './api/browse-embedded.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));

setupStatusRoutes(app);
setupEmbeddedBrowserRoutes(app);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});