const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => { console.log('Connected to MongoDB'); await runMaintenance(); setInterval(runMaintenance, 60 * 60 * 1000); })
  .catch(err => console.error('MongoDB connection error:', err));

/* =========================================================
   MODELS
   ========================================================= */

const slotSchema = new mongoose.Schema({
  sellerName: { type: String, required: true },
  mealType: { type: String, required: true },
  mealTime: { type: Date, required: true },
  cutoffTime: { type: Date, required: true },

  items: { type: String, required: true },

  maxPortions: { type: Number, required: true },
  ordersCount: { type: Number, default: 0 },

  pricePerPortion: { type: Number, required: true },

  location: String,
  latitude: Number,
  longitude: Number,

  upiId: String,
  sellerPhone: String,
  sellerEmail: String,

  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  slotId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },

  buyerName: { type: String, required: true },
  buyerPhone: String,
  buyerEmail: String,

  quantity: {
    type: Number,
    required: true,
    min: 1
  },

  status: {
    type: String,
    enum: [
      'pending',
      'accepted',
      'timed_out',
      'rejected',
      'cancelled_by_buyer',
      'cancelled_by_seller'
    ],
    default: 'pending'
  },

  cancelReason: String,

  slotSnapshot: { sellerName: String, mealType: String, mealTime: Date, cutoffTime: Date, items: String, pricePerPortion: Number, sellerPhone: String },

  createdAt: { type: Date, default: Date.now }
});

const notificationSchema = new mongoose.Schema({
  recipientRole: { type: String, enum: ['buyer', 'seller'], required: true },
  recipientName: { type: String, required: true },
  message: { type: String, required: true },
  orderId: mongoose.Schema.Types.ObjectId,
  slotId: mongoose.Schema.Types.ObjectId,
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const ratingSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
  raterRole: { type: String, enum: ['buyer', 'seller'], required: true },
  raterName: { type: String, required: true }, ratedName: { type: String, required: true },
  scores: { type: Map, of: Number }, overall: { type: Number, required: true }, comment: String,
  defenseResponse: String, defenseCreatedAt: Date, revealed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Slot = mongoose.model('Slot', slotSchema);
const Order = mongoose.model('Order', orderSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Rating = mongoose.model('Rating', ratingSchema);
const archiveSchema = new mongoose.Schema({ originalType: String, originalId: mongoose.Schema.Types.ObjectId, data: mongoose.Schema.Types.Mixed, archivedAt: { type: Date, default: Date.now } });
const Archive = mongoose.model('Archive', archiveSchema);


/* =========================================================
   HELPERS
   ========================================================= */

function calculateCutoff(mealDateTime) {
  const mealTime = new Date(mealDateTime);
  return new Date(mealTime.getTime() - (3 * 60 * 60 * 1000));
}

function isSlotOpen(slot) {
  const now = new Date();

  return (
    now < new Date(slot.cutoffTime) &&
    slot.ordersCount < slot.maxPortions
  );
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );

  return R * c;
}

function isValidQuantity(value) {
  const number = Number(value);

  return Number.isInteger(number) && number > 0;
}

async function notify(recipientRole, recipientName, message, orderId, slotId) {
  try {
    await Notification.create({
      recipientRole,
      recipientName,
      message,
      orderId: orderId || null,
      slotId: slotId || null
    });
  } catch (err) {
    console.error('Notification create failed:', err.message);
  }
}

function computeSellerTitle(completedCount, avgRating) {
  if (completedCount >= 500 && avgRating >= 4.8) return 'Local Food Legend';
  if (completedCount >= 100 && avgRating >= 4.5) return 'Neighbourhood Favourite';
  if (completedCount >= 100) return 'Trusted Cook';
  if (completedCount >= 25) return 'Community Cook';
  if (completedCount >= 10) return 'New Cook';
  return 'New Cook';
}

function computeBuyerTitle(completedCount, avgRating, cancellationRate) {
  if (completedCount >= 100 && avgRating >= 4.8 && cancellationRate < 0.05) return 'Community Favourite';
  if (completedCount >= 50 && avgRating >= 4.5) return 'Trusted Neighbour';
  if (completedCount >= 25 && avgRating >= 4.2) return 'Reliable Neighbour';
  if (completedCount >= 25) return 'Regular Neighbour';
  return 'New Neighbour';
}


/*
  This is important for the controlled meal-editing rule.

  TRUE means at least one order for this meal has already
  been accepted by the seller.
*/
async function slotHasAcceptedOrder(slotId) {
  const accepted = await Order.exists({
    slotId,
    status: 'accepted'
  });

  return !!accepted;
}


/* =========================================================
   LIFECYCLE / RETENTION
   ========================================================= */
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
function buildSlotSnapshot(slot) { return { sellerName: slot.sellerName, mealType: slot.mealType, mealTime: slot.mealTime, cutoffTime: slot.cutoffTime, items: slot.items, pricePerPortion: slot.pricePerPortion, sellerPhone: slot.sellerPhone }; }
async function expireTimedOutOrders() {
  const slots = await Slot.find({ cutoffTime: { $lte: new Date() } });
  for (const slot of slots) {
    const pending = await Order.find({ slotId: slot._id, status: 'pending' });
    for (const order of pending) {
      order.status = 'timed_out';
      order.cancelReason = 'Seller did not accept the order before the ordering window closed.';
      if (!order.slotSnapshot) order.slotSnapshot = buildSlotSnapshot(slot);
      await order.save();
      await notify('buyer', order.buyerName, `Your order for "${slot.items}" timed out because the seller did not accept it before the ordering window closed.`, order._id, slot._id);
    }
    const accepted = await Order.exists({ slotId: slot._id, status: 'accepted' });
    const stillPending = await Order.exists({ slotId: slot._id, status: 'pending' });
    if (!accepted && !stillPending) await Slot.deleteOne({ _id: slot._id });
  }
}
async function archiveOldData() {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  for (const [type, Model] of [['order', Order], ['rating', Rating], ['notification', Notification]]) {
    const docs = await Model.find({ createdAt: { $lt: cutoff } }).lean();
    if (docs.length) { await Archive.insertMany(docs.map(d => ({ originalType: type, originalId: d._id, data: d }))); await Model.deleteMany({ _id: { $in: docs.map(d => d._id) } }); }
  }
  const slots = await Slot.find({ createdAt: { $lt: cutoff } }).lean();
  if (slots.length) { await Archive.insertMany(slots.map(d => ({ originalType: 'slot', originalId: d._id, data: d }))); await Slot.deleteMany({ _id: { $in: slots.map(d => d._id) } }); }
}
async function runMaintenance() { try { await expireTimedOutOrders(); await archiveOldData(); } catch (err) { console.error('Maintenance error:', err.message); } }

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get('/', (req, res) => {
  res.send('FoodTime backend is running!');
});


/* =========================================================
   CREATE MENU
   ========================================================= */

app.post('/api/slots', async (req, res) => {
  try {
    const {
      sellerName,
      mealType,
      mealTime,
      items,
      maxPortions,
      pricePerPortion,
      location,
      latitude,
      longitude,
      upiId,
      sellerPhone,
      sellerEmail
    } = req.body;

    if (
      !sellerName ||
      !mealType ||
      !mealTime ||
      !items ||
      !maxPortions ||
      !pricePerPortion
    ) {
      return res.status(400).json({
        error: 'Missing required fields'
      });
    }

    if (!isValidQuantity(maxPortions)) {
      return res.status(400).json({
        error: 'Invalid number of portions'
      });
    }

    if (Number(pricePerPortion) <= 0) {
      return res.status(400).json({
        error: 'Price must be greater than zero'
      });
    }

    const mealDate = new Date(mealTime);

    if (isNaN(mealDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid meal time'
      });
    }

    const cutoffTime = calculateCutoff(mealDate);

    if (cutoffTime <= new Date()) {
      return res.status(400).json({
        error: 'Meal time must be at least 3 hours in the future'
      });
    }

    const newSlot = new Slot({
      sellerName: sellerName.trim(),
      mealType,
      mealTime: mealDate,
      cutoffTime,
      items: items.trim(),
      maxPortions: Number(maxPortions),
      pricePerPortion: Number(pricePerPortion),

      location: location ? location.trim() : null,

      latitude:
        latitude !== undefined && latitude !== null
          ? Number(latitude)
          : null,

      longitude:
        longitude !== undefined && longitude !== null
          ? Number(longitude)
          : null,const
      upiId: upiId ? upiId.trim() : null,
      sellerPhone: sellerPhone ? sellerPhone.trim() : null,
      sellerEmail: sellerEmail ? sellerEmail.trim() : null
    });

    await newSlot.save();

    res.status(201).json(newSlot);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   GET ALL MENUS
   ========================================================= */

app.get('/api/slots', async (req, res) => {
  try {
    await expireTimedOutOrders();
    const { lat, lng, radius } = req.query;

    const slots = await Slot.find()
      .sort({ mealTime: 1, createdAt: -1 });

    let result = slots.map(slot => {

      const obj = slot.toObject();

      obj.status = isSlotOpen(slot)
        ? 'open'
        : 'locked';

      if (
        lat &&
        lng &&
        slot.latitude !== null &&
        slot.latitude !== undefined &&
        slot.longitude !== null &&
        slot.longitude !== undefined
      ) {
        obj.distanceKm = getDistanceKm(
          parseFloat(lat),
          parseFloat(lng),
          slot.latitude,
          slot.longitude
        );
      }

      return obj;
    });

    if (lat && lng && radius) {

      result = result.filter(slot =>
        slot.distanceKm !== undefined &&
        slot.distanceKm <= parseFloat(radius)
      );

      result.sort(
        (a, b) => a.distanceKm - b.distanceKm
      );
    }

    res.json(result);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   GET SELLER MENUS
   ========================================================= */

app.get('/api/slots/seller/:sellerName', async (req, res) => {
  try {

    const sellerSlots = await Slot.find({
      sellerName: req.params.sellerName
    }).sort({
      mealTime: 1,
      createdAt: -1
    });

    const result = await Promise.all(
      sellerSlots.map(async slot => {

        const acceptedOrder = await Order.exists({
          slotId: slot._id,
          status: 'accepted'
        });

        const pendingOrders = await Order.countDocuments({
          slotId: slot._id,
          status: 'pending'
        });

        const rejectedOrders = await Order.countDocuments({
          slotId: slot._id,
          status: 'rejected'
        });

        return {
          ...slot.toObject(),

          hasAcceptedOrders: !!acceptedOrder,

          hasPendingOrders: pendingOrders > 0,

          pendingOrdersCount: pendingOrders,

          rejectedOrdersCount: rejectedOrders,

          canFullyEdit: !acceptedOrder,

          canIncreaseOnly: !!acceptedOrder,

          status: isSlotOpen(slot)
            ? 'open'
            : 'locked'
        };
      })
    );

    res.json(result);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================================================
   EDIT MENU
   =========================================================

   BEFORE ANY ORDER IS ACCEPTED:
      Seller can change:
      - meal type
      - meal time
      - menu items
      - price
      - quantity
      - location
      - UPI
      - phone
      - email

   AFTER AN ORDER IS ACCEPTED:
      Seller can ONLY:
      - increase maxPortions
      - increase mealTime

   Everything else is rejected by the server.
   ========================================================= */

app.patch('/api/slots/:id', async (req, res) => {
  try {

    const slot = await Slot.findById(req.params.id);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    const acceptedOrderExists =
      await slotHasAcceptedOrder(slot._id);

    const {
      mealType,
      mealTime,
      items,
      maxPortions,
      pricePerPortion,
      location,
      latitude,
      longitude,
      upiId,
      sellerPhone,
      sellerEmail
    } = req.body;


    /* -----------------------------------------------------
       AFTER ACCEPTANCE
       ----------------------------------------------------- */

    if (acceptedOrderExists) {

      const allowedFields = [
        'mealTime',
        'maxPortions'
      ];

      const suppliedFields =
        Object.keys(req.body).filter(
          key => req.body[key] !== undefined
        );

      const invalidField = suppliedFields.find(
        key => !allowedFields.includes(key)
      );

      if (invalidField) {
        return res.status(400).json({
          error:
            'This meal already has an accepted order. You can only increase available portions or extend the meal time.'
        });
      }


      /* Increase portions only */

      if (maxPortions !== undefined) {

        const newMax = Number(maxPortions);

        if (!isValidQuantity(newMax)) {
          return res.status(400).json({
            error: 'Invalid portion quantity'
          });
        }

        if (newMax < slot.maxPortions) {
          return res.status(400).json({
            error:
              'After an order is accepted, available portions can only be increased.'
          });
        }

        slot.maxPortions = newMax;
      }


      /* Extend meal time only */

      if (mealTime !== undefined) {

        const newMealTime = new Date(mealTime);

        if (isNaN(newMealTime.getTime())) {
          return res.status(400).json({
            error: 'Invalid meal time'
          });
        }

        if (newMealTime <= slot.mealTime) {
          return res.status(400).json({
            error:
              'After an order is accepted, meal time can only be extended.'
          });
        }

        slot.mealTime = newMealTime;
        slot.cutoffTime = calculateCutoff(newMealTime);
      }


      await slot.save();

      return res.json({
        success: true,
        message:
          'Menu updated. Only increased portions/time are allowed after acceptance.',
        slot
      });
    }


    /* -----------------------------------------------------
       BEFORE ACCEPTANCE
       ----------------------------------------------------- */

    if (mealType !== undefined) {
      slot.mealType = mealType;
    }

    if (mealTime !== undefined) {

      const newMealTime = new Date(mealTime);

      if (isNaN(newMealTime.getTime())) {
        return res.status(400).json({
          error: 'Invalid meal time'
        });
      }

      if (newMealTime <= new Date()) {
        return res.status(400).json({
          error: 'Meal time must be in the future'
        });
      }

      slot.mealTime = newMealTime;
      slot.cutoffTime = calculateCutoff(newMealTime);
    }

    if (items !== undefined) {
      if (!String(items).trim()) {
        return res.status(400).json({
          error: 'Menu items cannot be empty'
        });
      }

      slot.items = String(items).trim();
    }

    if (pricePerPortion !== undefined) {

      const price = Number(pricePerPortion);

      if (price <= 0) {
        return res.status(400).json({
          error: 'Price must be greater than zero'
        });
      }

      slot.pricePerPortion = price;
    }

    if (maxPortions !== undefined) {

      const portions = Number(maxPortions);

      if (!isValidQuantity(portions)) {
        return res.status(400).json({
          error: 'Invalid number of portions'
        });
      }

      if (portions < slot.ordersCount) {
        return res.status(400).json({
          error:
            `You cannot set portions below the ${slot.ordersCount} portions already ordered.`
        });
      }

      slot.maxPortions = portions;
    }

    if (location !== undefined) {
      slot.location = location
        ? String(location).trim()
        : null;
    }

    if (latitude !== undefined) {
      slot.latitude =
        latitude === null || latitude === ''
          ? null
          : Number(latitude);
    }

    if (longitude !== undefined) {
      slot.longitude =
        longitude === null || longitude === ''
          ? null
          : Number(longitude);
    }

    if (upiId !== undefined) {
      slot.upiId = upiId
        ? String(upiId).trim()
        : null;
    }

    if (sellerPhone !== undefined) {
      slot.sellerPhone = sellerPhone
        ? String(sellerPhone).trim()
        : null;
    }

    if (sellerEmail !== undefined) {
      slot.sellerEmail = sellerEmail
        ? String(sellerEmail).trim()
        : null;
    }

    await slot.save();

    res.json({
      success: true,
      message: 'Menu updated successfully.',
      slot
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   ORDERS FOR A MENU
   ========================================================= */

app.get('/api/slots/:id/orders', async (req, res) => {
  try {

    const orders = await Order.find({
      slotId: req.params.id
    }).sort({
      createdAt: -1
    });

    res.json(orders);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });
  }
});

