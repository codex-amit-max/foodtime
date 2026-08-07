const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ---- In-memory storage for now (we'll add a real database next) ----
let mealSlots = [];
let orders = [];
let nextSlotId = 1;
let nextOrderId = 1;

function calculateCutoff(mealDateTime) {
  const mealTime = new Date(mealDateTime);
  return new Date(mealTime.getTime() - 3 * 60 * 60 * 1000);
}

function isSlotOpen(slot) {
  const now = new Date();
  return now < new Date(slot.cutoffTime) && slot.ordersCount < slot.maxPortions;
}

app.post('/api/slots', (req, res) => {
  const { sellerName, mealType, mealTime, items, maxPortions, location } = req.body;
  if (!sellerName || !mealType || !mealTime || !items || !maxPortions) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const cutoffTime = calculateCutoff(mealTime);
  const newSlot = {
    id: nextSlotId++, sellerName, mealType, mealTime, cutoffTime,
    items, maxPortions, ordersCount: 0, location: location || null,
    status: 'open', createdAt: new Date()
  };
  mealSlots.push(newSlot);
  res.status(201).json(newSlot);
});

app.get('/api/slots', (req, res) => {
  mealSlots.forEach(slot => { slot.status = isSlotOpen(slot) ? 'open' : 'locked'; });
  res.json(mealSlots);
});

app.get('/api/slots/seller/:sellerName', (req, res) => {
  res.json(mealSlots.filter(s => s.sellerName === req.params.sellerName));
});

app.post('/api/orders', (req, res) => {
  const { slotId, buyerName, quantity } = req.body;
  const slot = mealSlots.find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (!isSlotOpen(slot)) return res.status(400).json({ error: 'Ordering is closed for this slot' });
  if (slot.ordersCount + quantity > slot.maxPortions) {
    return res.status(400).json({ error: 'Not enough portions left' });
  }
  const newOrder = { id: nextOrderId++, slotId, buyerName, quantity, createdAt: new Date() };
  orders.push(newOrder);
  slot.ordersCount += quantity;
  res.status(201).json(newOrder);
});

app.get('/api/slots/:id/countdown', (req, res) => {
  const slot = mealSlots.find(s => s.id === parseInt(req.params.id));
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  const msRemaining = new Date(slot.cutoffTime) - new Date();
  res.json({
    slotId: slot.id,
    isOpen: msRemaining > 0,
    minutesRemaining: Math.max(0, Math.floor(msRemaining / 60000))
  });
});

app.get('/', (req, res) => res.send('FoodTime backend is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodTime server running on port ${PORT}`));