const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Connect to MongoDB ----
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// ---- Database Schemas ----
const slotSchema = new mongoose.Schema({
  sellerName: String,
  mealType: String,
  mealTime: Date,
  cutoffTime: Date,
  items: String,
  maxPortions: Number,
  ordersCount: { type: Number, default: 0 },
  location: String,
  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  slotId: mongoose.Schema.Types.ObjectId,
  buyerName: String,
  quantity: Number,
  createdAt: { type: Date, default: Date.now }
});

const Slot = mongoose.model('Slot', slotSchema);
const Order = mongoose.model('Order', orderSchema);

function calculateCutoff(mealDateTime) {
  const mealTime = new Date(mealDateTime);
  return new Date(mealTime.getTime() - 3 * 60 * 60 * 1000);
}

function isSlotOpen(slot) {
  const now = new Date();
  return now < new Date(slot.cutoffTime) && slot.ordersCount < slot.maxPortions;
}

app.post('/api/slots', async (req, res) => {
  try {
    const { sellerName, mealType, mealTime, items, maxPortions, location } = req.body;
    if (!sellerName || !mealType || !mealTime || !items || !maxPortions) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const cutoffTime = calculateCutoff(mealTime);
    const newSlot = new Slot({ sellerName, mealType, mealTime, cutoffTime, items, maxPortions, location: location || null });
    await newSlot.save();
    res.status(201).json(newSlot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slots', async (req, res) => {
  try {
    const slots = await Slot.find().sort({ createdAt: -1 });
    const slotsWithStatus = slots.map(slot => ({ ...slot.toObject(), status: isSlotOpen(slot) ? 'open' : 'locked' }));
    res.json(slotsWithStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slots/seller/:sellerName', async (req, res) => {
  try {
    const sellerSlots = await Slot.find({ sellerName: req.params.sellerName }).sort({ createdAt: -1 });
    res.json(sellerSlots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { slotId, buyerName, quantity } = req.body;
    const slot = await Slot.findById(slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (!isSlotOpen(slot)) return res.status(400).json({ error: 'Ordering is closed for this slot' });
    if (slot.ordersCount + quantity > slot.maxPortions) return res.status(400).json({ error: 'Not enough portions left' });
    const newOrder = new Order({ slotId, buyerName, quantity });
    await newOrder.save();
    slot.ordersCount += quantity;
    await slot.save();
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slots/:id/countdown', async (req, res) => {
  try {
    const slot = await Slot.findById(req.params.id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    const msRemaining = new Date(slot.cutoffTime) - new Date();
    res.json({ slotId: slot._id, isOpen: msRemaining > 0, minutesRemaining: Math.max(0, Math.floor(msRemaining / 60000)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('FoodTime backend is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FoodTime server running on port ${PORT}`));