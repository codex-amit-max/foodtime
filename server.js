const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
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
      'rejected',
      'cancelled_by_buyer',
      'cancelled_by_seller'
    ],
    default: 'pending'
  },

  cancelReason: String,

  createdAt: { type: Date, default: Date.now }
});

const Slot = mongoose.model('Slot', slotSchema);
const Order = mongoose.model('Order', orderSchema);


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
          : null,

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

          hasAcceptedOrder: !!acceptedOrder,

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


/* =========================================================
   PLACE ORDER
   ========================================================= */

app.post('/api/orders', async (req, res) => {
  try {

    const {
      slotId,
      buyerName,
      buyerPhone,
      buyerEmail,
      quantity
    } = req.body;

    if (!slotId || !buyerName) {
      return res.status(400).json({
        error: 'Buyer name and menu are required'
      });
    }

    if (!isValidQuantity(quantity)) {
      return res.status(400).json({
        error: 'Invalid quantity'
      });
    }

    const slot = await Slot.findById(slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    if (!isSlotOpen(slot)) {
      return res.status(400).json({
        error: 'Ordering is closed for this menu'
      });
    }

    const qty = Number(quantity);

    if (
      slot.ordersCount + qty >
      slot.maxPortions
    ) {
      return res.status(400).json({
        error:
          `Only ${slot.maxPortions - slot.ordersCount} portions are available`
      });
    }

    const newOrder = new Order({
      slotId,
      buyerName: buyerName.trim(),
      buyerPhone: buyerPhone
        ? buyerPhone.trim()
        : null,
      buyerEmail: buyerEmail
        ? buyerEmail.trim()
        : null,
      quantity: qty,
      status: 'pending'
    });

    await newOrder.save();

    slot.ordersCount += qty;

    await slot.save();

    res.status(201).json(newOrder);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   BUYER ORDERS
   ========================================================= */

app.get('/api/orders/buyer/:buyerName', async (req, res) => {
  try {

    const orders = await Order.find({
      buyerName: req.params.buyerName
    }).sort({
      createdAt: -1
    });

    const result = await Promise.all(
      orders.map(async order => {

        const slot =
          await Slot.findById(order.slotId);

        return {
          _id: order._id,

          buyerName: order.buyerName,

          buyerPhone: order.buyerPhone,

          buyerEmail: order.buyerEmail,

          quantity: order.quantity,

          status: order.status,

          cancelReason: order.cancelReason,

          createdAt: order.createdAt,

          slot: slot
            ? {
                _id: slot._id,
                sellerName: slot.sellerName,
                mealType: slot.mealType,
                mealTime: slot.mealTime,
                cutoffTime: slot.cutoffTime,
                items: slot.items,
                pricePerPortion:
                  slot.pricePerPortion,
                upiId: slot.upiId,
                sellerPhone:
                  slot.sellerPhone,

                canCancel:
                  new Date(slot.cutoffTime) >
                  new Date()
              }
            : null
        };
      })
    );

    res.json(result);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   SELLER ORDERS
   ========================================================= */

app.get('/api/orders/seller/:sellerName', async (req, res) => {
  try {

    const slots = await Slot.find({
      sellerName: req.params.sellerName
    });

    const slotIds =
      slots.map(slot => slot._id);

    const orders = await Order.find({
      slotId: { $in: slotIds }
    }).sort({
      createdAt: -1
    });

    const slotMap = {};

    slots.forEach(slot => {
      slotMap[slot._id.toString()] =
        slot;
    });

    const result = orders.map(order => {

      const slot =
        slotMap[order.slotId.toString()];

      return {
        _id: order._id,

        buyerName:
          order.buyerName,

        buyerPhone:
          order.buyerPhone,

        buyerEmail:
          order.buyerEmail,

        quantity:
          order.quantity,

        status:
          order.status,

        cancelReason:
          order.cancelReason,

        createdAt:
          order.createdAt,

        slot: slot
          ? {
              _id: slot._id,
              mealType: slot.mealType,
              mealTime: slot.mealTime,
              cutoffTime: slot.cutoffTime,
              items: slot.items,
              pricePerPortion:
                slot.pricePerPortion
            }
          : null
      };
    });

    res.json(result);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   ACCEPT ORDER
   ========================================================= */

app.patch('/api/orders/:id/accept', async (req, res) => {
  try {

    const order =
      await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({
        error:
          `This order is already ${order.status}.`
      });
    }

    const slot =
      await Slot.findById(order.slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    if (new Date(slot.cutoffTime) <= new Date()) {
      return res.status(400).json({
        error:
          'The ordering window has already closed.'
      });
    }

    order.status = 'accepted';

    await order.save();

    res.json({
      success: true,
      message: 'Order accepted.',
      order
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
   });
  }
});


/* =========================================================
   REJECT ORDER
   =========================================================

   Mandatory rejection reason.
   ========================================================= */

app.patch('/api/orders/:id/reject', async (req, res) => {
  try {

    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error:
          'A rejection reason is required.'
      });
    }

    const order =
      await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({
        error:
          `This order is already ${order.status}.`
      });
    }

    const slot =
      await Slot.findById(order.slotId);

    if (slot) {

      slot.ordersCount =
        Math.max(
          0,
          slot.ordersCount - order.quantity
        );

      await slot.save();
    }

    order.status = 'rejected';

    order.cancelReason =
      reason.trim();

    await order.save();

    res.json({
      success: true,
      message: 'Order rejected.',
      order
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});
/* =========================================================
   SELLER CANCEL ORDER
   ========================================================= */

app.patch('/api/orders/:id/seller-cancel', async (req, res) => {
  try {

    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error:
          'A reason is required to cancel this order.'
      });
    }

    const order =
      await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (
      [
        'rejected',
        'cancelled_by_buyer',
        'cancelled_by_seller'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error:
          'This order is already cancelled.'
      });
    }

    const slot =
      await Slot.findById(order.slotId);

    if (slot) {

      slot.ordersCount =
        Math.max(
          0,
          slot.ordersCount - order.quantity
        );

      await slot.save();
    }

    order.status =
      'cancelled_by_seller';

    order.cancelReason =
      reason.trim();

    await order.save();

    res.json({
      success: true,
      message: 'Order cancelled.',
      order
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   EDIT ORDER QUANTITY
   =========================================================

   Kept for compatibility with your existing application.

   Seller can change the order quantity while the order
   is pending or accepted, provided there is capacity.
   ========================================================= */

app.patch('/api/orders/:id', async (req, res) => {
  try {

    const { quantity } = req.body;

    if (!isValidQuantity(quantity)) {
      return res.status(400).json({
        error: 'Invalid quantity'
      });
    }

    const order =
      await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (
      [
        'rejected',
        'cancelled_by_buyer',
        'cancelled_by_seller'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error:
          'Cannot edit a cancelled order.'
      });
    }

    const slot =
      await Slot.findById(order.slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    const newQuantity =
      Number(quantity);

    const difference =
      newQuantity - order.quantity;

    if (
      slot.ordersCount + difference >
      slot.maxPortions
    ) {
      return res.status(400).json({
        error:
          'Not enough portions available for this change.'
      });
    }

    if (
      slot.ordersCount + difference < 0
    ) {
      return res.status(400).json({
        error: 'Invalid quantity change.'
      });
    }

    slot.ordersCount += difference;

    await slot.save();

    order.quantity =
      newQuantity;

    await order.save();

    res.json({
      success: true,
      order
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================================================
   BUYER CANCEL ORDER
   ========================================================= */

app.delete('/api/orders/:id', async (req, res) => {
  try {

    const order =
      await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    if (
      [
        'rejected',
        'cancelled_by_buyer',
        'cancelled_by_seller'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error:
          'This order is already cancelled.'
      });
    }

    const slot =
      await Slot.findById(order.slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    if (
      new Date(slot.cutoffTime) <=
      new Date()
    ) {
      return res.status(400).json({
        error:
          'Cannot cancel — ordering window has closed.'
      });
    }

    const minutesSinceOrder =
      (
        new Date() -
        new Date(order.createdAt)
      ) / 60000;

    let refundPolicy = 'full';

    if (minutesSinceOrder > 30) {
      refundPolicy = 'none';
    } else if (minutesSinceOrder > 10) {
      refundPolicy = 'half';
    }

    slot.ordersCount =
      Math.max(
        0,
        slot.ordersCount - order.quantity
      );

    await slot.save();

    order.status =
      'cancelled_by_buyer';

    order.cancelReason =
      'Cancelled by buyer';

    await order.save();

    res.json({
      success: true,
      refundPolicy,
      minutesSinceOrder:
        Math.round(minutesSinceOrder)
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   COUNTDOWN
   ========================================================= */

app.get('/api/slots/:id/countdown', async (req, res) => {
  try {

    const slot =
      await Slot.findById(req.params.id);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    const msRemaining =
      new Date(slot.cutoffTime) -
      new Date();

    res.json({
      slotId: slot._id,

      isOpen:
        msRemaining > 0 &&
        slot.ordersCount <
        slot.maxPortions,

      minutesRemaining:
        Math.max(
          0,
          Math.floor(
            msRemaining / 60000
          )
        )
    });

  } catch (err) {

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   START SERVER
   ========================================================= */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `FoodTime server running on port ${PORT}`
  );
});
