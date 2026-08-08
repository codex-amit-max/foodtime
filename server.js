const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const slotSchema = new mongoose.Schema({
  sellerName: String,
  mealType: String,
  mealTime: Date,
  cutoffTime: Date,
  items: String,
  maxPortions: Number,
  ordersCount: { type: Number, default: 0 },
  pricePerPortion: Number,
  location: String,
  latitude: Number,
  longitude: Number,
  upiId: String,
  sellerPhone: String,
  sellerEmail: String,
  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  slotId: mongoose.Schema.Types.ObjectId,
  buyerName: String,
  buyerPhone: String,
  buyerEmail: String,
  quantity: Number,
  status: { type: String, default: 'pending' },
  cancelReason: String,
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

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.post('/api/slots', async (req, res) => {
  try {
    const {
      sellerName, mealType, mealTime, items, maxPortions, pricePerPortion,
      location, latitude, longitude, upiId, sellerPhone, sellerEmail
    } = req.body;
    if (!sellerName || !mealType || !mealTime || !items || !maxPortions || !pricePerPortion) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const cutoffTime = calculateCutoff(mealTime);
    const newSlot = new Slot({
      sellerName, mealType, mealTime, cutoffTime, items, maxPortions,
      pricePerPortion,
      location: location || null,
      latitude: latitude || null,
      longitude: longitude || null,
      upiId: upiId || null,
      sellerPhone: sellerPhone || null,
      sellerEmail: sellerEmail || null
    });
    await newSlot.save();
    res.status(201).json(newSlot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slots', async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;
    let slots = await Slot.find().sort({ createdAt: -1 });

    let result = slots.map(slot => {
      const obj = slot.toObject();
      obj.status = isSlotOpen(slot) ? 'open' : 'locked';
      if (lat && lng && slot.latitude != null && slot.longitude != null) {
        obj.distanceKm = getDistanceKm(parseFloat(lat), parseFloat(lng), slot.latitude, slot.longitude);
      }
      return obj;
    });

    if (lat && lng && radius) {
      result = result.filter(s => s.distanceKm != null && s.distanceKm <= parseFloat(radius));
      result.sort((a, b) => a.distanceKm - b.distanceKm);
    }

    res.json(result);
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

app.get('/api/slots/:id/orders', async (req, res) => {
  try {
    const orders = await Order.find({ slotId: req.params.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { slotId, buyerName, buyerPhone, buyerEmail, quantity } = req.body;
    const slot = await Slot.findById(slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (!isSlotOpen(slot)) return res.status(400).json({ error: 'Ordering is closed for this slot' });
    if (slot.ordersCount + quantity > slot.maxPortions) return res.status(400).json({ error: 'Not enough portions left' });
    const newOrder = new Order({ slotId, buyerName, buyerPhone: buyerPhone || null, buyerEmail: buyerEmail || null, quantity });
    await newOrder.save();
    slot.ordersCount += quantity;
    await slot.save();
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/buyer/:buyerName', async (req, res) => {
  try {
    const orders = await Order.find({ buyerName: req.params.buyerName }).sort({ createdAt: -1 });
    const withSlots = await Promise.all(orders.map(async (order) => {
      const slot = await Slot.findById(order.slotId);
      return {
        _id: order._id,
        quantity: order.quantity,
        status: order.status,
        cancelReason: order.cancelReason,
        createdAt: order.createdAt,
        slot: slot ? {
          _id: slot._id,
          sellerName: slot.sellerName,
          mealType: slot.mealType,
          mealTime: slot.mealTime,
          cutoffTime: slot.cutoffTime,
          items: slot.items,
          pricePerPortion: slot.pricePerPortion,
          upiId: slot.upiId,
          sellerPhone: slot.sellerPhone,
          canCancel: new Date(slot.cutoffTime) > new Date()
        } : null
      };
    }));
    res.json(withSlots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/seller/:sellerName', async (req, res) => {
  try {
    const slots = await Slot.find({ sellerName: req.params.sellerName });
    const orders = await Order.find({ slotId: { $in: slots.map(s => s._id) } }).sort({ createdAt: -1 });
    const slotMap = {};
    slots.forEach(s => { slotMap[s._id.toString()] = s; });

    const result = orders.map(o => {
      const s = slotMap[o.slotId.toString()];
      return {
        _id: o._id,
        buyerName: o.buyerName,
        buyerPhone: o.buyerPhone,
        quantity: o.quantity,
        status: o.status,
        cancelReason: o.cancelReason,
        createdAt: o.createdAt,
        slot: s ? {
          _id: s._id,
          mealType: s.mealType,
          mealTime: s.mealTime,
          cutoffTime: s.cutoffTime,
          items: s.items,
          pricePerPortion: s.pricePerPortion
        } : null
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/accept', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.status = 'accepted';
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/seller-cancel', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required to cancel this order' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['rejected', 'cancelled_by_buyer', 'cancelled_by_seller'].includes(order.status)) {
      return res.status(400).json({ error: 'Order is already cancelled' });
    }
    const slot = await Slot.findById(order.slotId);
    if (slot) {
      slot.ordersCount = Math.max(0, slot.ordersCount - order.quantity);
      await slot.save();
    }
    order.status = 'cancelled_by_seller';
    order.cancelReason = reason.trim();
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id', async (req, res) => {
  try {
    const { quantity } = req.body;
    if (!quantity || quantity < 1) return res.status(400).json({ error: 'Invalid quantity' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['rejected', 'cancelled_by_buyer', 'cancelled_by_seller'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot edit a cancelled order' });
    }
    const slot = await Slot.findById(order.slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    const delta = quantity - order.quantity;
    if (slot.ordersCount + delta > slot.maxPortions) {
      return res.status(400).json({ error: 'Not enough portions left for this change' });
    }
    slot.ordersCount = Math.max(0, slot.ordersCount + delta);
    await slot.save();
    order.quantity = quantity;
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const slot = await Slot.findById(order.slotId);
    if (slot) {
      if (new Date(slot.cutoffTime) <= new Date()) {
        return res.status(400).json({ error: 'Cannot cancel — ordering window has closed' });
      }
      slot.ordersCount = Math.max(0, slot.ordersCount - order.quantity);
      await slot.save();
    }

    const minutesSinceOrder = (new Date() - new Date(order.createdAt)) / 60000;
    let refundPolicy = 'full';
    if (minutesSinceOrder > 30) refundPolicy = 'none';
    else if (minutesSinceOrder > 10) refundPolicy = 'half';

    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true, refundPolicy, minutesSinceOrder: Math.round(minutesSinceOrder) });
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
