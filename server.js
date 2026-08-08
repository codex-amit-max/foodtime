const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   DATABASE
========================================================= */

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));


/* =========================================================
   SLOT / MENU SCHEMA
========================================================= */

const slotSchema = new mongoose.Schema({
  sellerName: {
    type: String,
    required: true,
    trim: true
  },

  mealType: {
    type: String,
    required: true,
    enum: ['breakfast', 'lunch', 'dinner']
  },

  mealTime: {
    type: Date,
    required: true
  },

  cutoffTime: {
    type: Date,
    required: true
  },

  items: {
    type: String,
    required: true,
    trim: true
  },

  maxPortions: {
    type: Number,
    required: true,
    min: 1
  },

  /*
   * This represents portions reserved by all active orders.
   *
   * Pending orders reserve portions.
   * Accepted orders reserve portions.
   * Rejected/cancelled orders release portions.
   */
  ordersCount: {
    type: Number,
    default: 0,
    min: 0
  },

  pricePerPortion: {
    type: Number,
    required: true,
    min: 1
  },

  location: {
    type: String,
    default: null
  },

  latitude: {
    type: Number,
    default: null
  },

  longitude: {
    type: Number,
    default: null
  },

  upiId: {
    type: String,
    default: null
  },

  sellerPhone: {
    type: String,
    default: null
  },

  sellerEmail: {
    type: String,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});


/* =========================================================
   ORDER SCHEMA
========================================================= */

const orderSchema = new mongoose.Schema({
  slotId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },

  buyerName: {
    type: String,
    required: true,
    trim: true
  },

  buyerPhone: {
    type: String,
    default: null
  },

  buyerEmail: {
    type: String,
    default: null
  },

  quantity: {
    type: Number,
    required: true,
    min: 1
  },

  /*
   * pending
   * accepted
   * rejected
   * cancelled_by_buyer
   * cancelled_by_seller
   */
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

  cancelReason: {
    type: String,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});


const Slot = mongoose.model('Slot', slotSchema);
const Order = mongoose.model('Order', orderSchema);


/* =========================================================
   HELPER FUNCTIONS
========================================================= */

function calculateCutoff(mealDateTime) {
  const mealTime = new Date(mealDateTime);

  return new Date(
    mealTime.getTime() - (3 * 60 * 60 * 1000)
  );
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

  const c =
    2 * Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}


function hasAcceptedOrders(slotId) {
  return Order.exists({
    slotId,
    status: 'accepted'
  });
}


function hasActiveOrders(slotId) {
  return Order.exists({
    slotId,
    status: {
      $in: ['pending', 'accepted']
    }
  });
}


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

    const parsedMealTime = new Date(mealTime);

    if (isNaN(parsedMealTime.getTime())) {
      return res.status(400).json({
        error: 'Invalid meal time'
      });
    }

    if (parsedMealTime <= new Date()) {
      return res.status(400).json({
        error: 'Meal time must be in the future'
      });
    }

    const parsedMaxPortions = Number(maxPortions);
    const parsedPrice = Number(pricePerPortion);

    if (
      !Number.isInteger(parsedMaxPortions) ||
      parsedMaxPortions < 1
    ) {
      return res.status(400).json({
        error: 'Maximum portions must be at least 1'
      });
    }

    if (
      !Number.isFinite(parsedPrice) ||
      parsedPrice <= 0
    ) {
      return res.status(400).json({
        error: 'Price must be greater than zero'
      });
    }

    const cutoffTime = calculateCutoff(parsedMealTime);

    if (cutoffTime <= new Date()) {
      return res.status(400).json({
        error: 'Meal time must be at least 3 hours in the future'
      });
    }

    const newSlot = new Slot({
      sellerName: sellerName.trim(),
      mealType,
      mealTime: parsedMealTime,
      cutoffTime,
      items: items.trim(),
      maxPortions: parsedMaxPortions,
      ordersCount: 0,
      pricePerPortion: parsedPrice,

      location: location ? location.trim() : null,

      latitude:
        latitude !== undefined &&
        latitude !== null &&
        latitude !== ''
          ? Number(latitude)
          : null,

      longitude:
        longitude !== undefined &&
        longitude !== null &&
        longitude !== ''
          ? Number(longitude)
          : null,

      upiId: upiId ? upiId.trim() : null,
      sellerPhone: sellerPhone ? sellerPhone.trim() : null,
      sellerEmail: sellerEmail ? sellerEmail.trim() : null
    });

    await newSlot.save();

    res.status(201).json(newSlot);

  } catch (err) {
    console.error('Create slot error:', err);

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
    const {
      lat,
      lng,
      radius
    } = req.query;

    let slots = await Slot
      .find()
      .sort({ createdAt: -1 });

    let result = slots.map(slot => {

      const obj = slot.toObject();

      obj.status = isSlotOpen(slot)
        ? 'open'
        : 'locked';

      obj.portionsLeft = Math.max(
        0,
        slot.maxPortions - slot.ordersCount
      );

      if (
        lat &&
        lng &&
        slot.latitude != null &&
        slot.longitude != null
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

      result = result.filter(
        s =>
          s.distanceKm != null &&
          s.distanceKm <= parseFloat(radius)
      );

      result.sort(
        (a, b) =>
          a.distanceKm - b.distanceKm
      );
    }

    res.json(result);

  } catch (err) {
    console.error('Get slots error:', err);

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

    const sellerSlots = await Slot
      .find({
        sellerName: req.params.sellerName
      })
      .sort({
        createdAt: -1
      });

    const result = await Promise.all(
      sellerSlots.map(async slot => {

        const acceptedOrders = await Order.countDocuments({
          slotId: slot._id,
          status: 'accepted'
        });

        const pendingOrders = await Order.countDocuments({
          slotId: slot._id,
          status: 'pending'
        });

        return {
          ...slot.toObject(),

          acceptedOrders,
          pendingOrders,

          /*
           * Menu can be fully edited only if
           * there are no accepted orders.
           */
          canFullyEdit:
            acceptedOrders === 0 &&
            new Date(slot.cutoffTime) > new Date(),

          /*
           * After acceptance, only:
           * - increase max portions
           * - move meal time later
           */
          canLimitedEdit:
            acceptedOrders > 0 &&
            new Date(slot.cutoffTime) > new Date()
        };
      })
    );

    res.json(result);

  } catch (err) {
    console.error('Get seller slots error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   EDIT MENU
=========================================================

   RULES:

   BEFORE ANY ACCEPTED ORDER:
      seller can change:
        mealType
        mealTime
        items
        maxPortions
        price
        location
        UPI
        phone
        email

   AFTER AN ACCEPTED ORDER:
      seller can ONLY:
        increase maxPortions
        increase mealTime

   NEVER:
        reduce maxPortions below already reserved quantity
        move mealTime earlier
        change price after acceptance
        change food/items after acceptance
========================================================= */

app.patch('/api/slots/:id', async (req, res) => {
  try {

    const slot = await Slot.findById(req.params.id);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    const now = new Date();

    if (now >= new Date(slot.cutoffTime)) {
      return res.status(400).json({
        error: 'This menu can no longer be edited because the ordering window has closed'
      });
    }

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


    /*
     * For the current prototype we use sellerName
     * as the seller identity.
     */
    if (
      sellerName &&
      sellerName.trim() !== slot.sellerName.trim()
    ) {
      return res.status(403).json({
        error: 'Seller identity does not match this menu'
      });
    }


    const acceptedOrders = await Order.countDocuments({
      slotId: slot._id,
      status: 'accepted'
    });


    /* =====================================================
       CASE 1: NO ACCEPTED ORDERS
       FULL EDITING ALLOWED
    ===================================================== */

    if (acceptedOrders === 0) {

      const newMealTime =
        mealTime !== undefined
          ? new Date(mealTime)
          : slot.mealTime;

      if (isNaN(newMealTime.getTime())) {
        return res.status(400).json({
          error: 'Invalid meal time'
        });
      }

      if (newMealTime <= now) {
        return res.status(400).json({
          error: 'Meal time must be in the future'
        });
      }

      const newCutoff =
        calculateCutoff(newMealTime);

      if (newCutoff <= now) {
        return res.status(400).json({
          error: 'Meal time must be at least 3 hours in the future'
        });
      }


      if (maxPortions !== undefined) {

        const newMax = Number(maxPortions);

        if (
          !Number.isInteger(newMax) ||
          newMax < 1
        ) {
          return res.status(400).json({
            error: 'Invalid maximum portions'
          });
        }

        /*
         * Never allow menu capacity below
         * currently reserved portions.
         */
        if (newMax < slot.ordersCount) {
          return res.status(400).json({
            error:
              `Maximum portions cannot be below ${slot.ordersCount}, which are already reserved`
          });
        }

        slot.maxPortions = newMax;
      }


      if (mealType !== undefined) {

        if (
          !['breakfast', 'lunch', 'dinner']
            .includes(mealType)
        ) {
          return res.status(400).json({
            error: 'Invalid meal type'
          });
        }

        slot.mealType = mealType;
      }


      if (items !== undefined) {

        if (!items.trim()) {
          return res.status(400).json({
            error: 'Menu description cannot be empty'
          });
        }

        slot.items = items.trim();
      }


      if (pricePerPortion !== undefined) {

        const newPrice =
          Number(pricePerPortion);

        if (
          !Number.isFinite(newPrice) ||
          newPrice <= 0
        ) {
          return res.status(400).json({
            error: 'Invalid price'
          });
        }

        slot.pricePerPortion = newPrice;
      }


      slot.mealTime = newMealTime;
      slot.cutoffTime = newCutoff;


      if (location !== undefined) {
        slot.location =
          location ? location.trim() : null;
      }

      if (latitude !== undefined) {
        slot.latitude =
          latitude === null ||
          latitude === ''
            ? null
            : Number(latitude);
      }

      if (longitude !== undefined) {
        slot.longitude =
          longitude === null ||
          longitude === ''
            ? null
            : Number(longitude);
      }

      if (upiId !== undefined) {
        slot.upiId =
          upiId ? upiId.trim() : null;
      }

      if (sellerPhone !== undefined) {
        slot.sellerPhone =
          sellerPhone ? sellerPhone.trim() : null;
      }

      if (sellerEmail !== undefined) {
        slot.sellerEmail =
          sellerEmail ? sellerEmail.trim() : null;
      }


      slot.updatedAt = new Date();

      await slot.save();

      return res.json({
        success: true,
        mode: 'full_edit',
        message: 'Menu updated successfully',
        slot
      });
    }


    /* =====================================================
       CASE 2: ACCEPTED ORDERS EXIST
       LIMITED EDITING ONLY
    ===================================================== */

    const currentMealTime =
      new Date(slot.mealTime);

    let newMealTime = currentMealTime;

    if (mealTime !== undefined) {

      newMealTime = new Date(mealTime);

      if (isNaN(newMealTime.getTime())) {
        return res.status(400).json({
          error: 'Invalid meal time'
        });
      }

      /*
       * Meal time can ONLY move later.
       */
      if (newMealTime < currentMealTime) {
        return res.status(400).json({
          error:
            'Once an order is accepted, meal time can only be increased/later'
        });
      }
    }


    if (
      mealType !== undefined ||
      items !== undefined ||
      pricePerPortion !== undefined ||
      location !== undefined ||
      latitude !== undefined ||
      longitude !== undefined ||
      upiId !== undefined ||
      sellerPhone !== undefined ||
      sellerEmail !== undefined
    ) {
      return res.status(400).json({
        error:
          'Once an order is accepted, only quantity and availability time can be increased'
      });
    }


    if (maxPortions !== undefined) {

      const newMax =
        Number(maxPortions);

      if (
        !Number.isInteger(newMax) ||
        newMax < slot.maxPortions
      ) {
        return res.status(400).json({
          error:
            'Once an order is accepted, available quantity can only be increased'
        });
      }

      slot.maxPortions = newMax;
    }


    /*
     * Recalculate cutoff whenever meal time
     * changes.
     */
    const newCutoff =
      calculateCutoff(newMealTime);

    if (newCutoff <= now) {
      return res.status(400).json({
        error:
          'The new meal time must leave at least 3 hours for ordering'
      });
    }

    slot.mealTime = newMealTime;
    slot.cutoffTime = newCutoff;
    slot.updatedAt = new Date();

    await slot.save();

    return res.json({
      success: true,
      mode: 'limited_edit',
      message:
        'Menu updated. Only quantity and availability time can be changed after acceptance.',
      slot
    });

  } catch (err) {

    console.error('Edit slot error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   GET ORDERS FOR A SLOT
========================================================= */

app.get('/api/slots/:id/orders', async (req, res) => {
  try {

    const orders = await Order
      .find({
        slotId: req.params.id
      })
      .sort({
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


    if (!slotId || !buyerName || !quantity) {
      return res.status(400).json({
        error: 'Missing required order information'
      });
    }


    const parsedQuantity =
      Number(quantity);

    if (
      !Number.isInteger(parsedQuantity) ||
      parsedQuantity < 1
    ) {
      return res.status(400).json({
        error: 'Invalid quantity'
      });
    }


    /*
     * Atomic update prevents two buyers from
     * simultaneously taking the last portion.
     */
    const cutoffNow = new Date();

    const slot = await Slot.findOneAndUpdate(
      {
        _id: slotId,
        cutoffTime: { $gt: cutoffNow },

        $expr: {
          $lte: [
            {
              $add: [
                '$ordersCount',
                parsedQuantity
              ]
            },
            '$maxPortions'
          ]
        }
      },
      {
        $inc: {
          ordersCount: parsedQuantity
        },

        $set: {
          updatedAt: new Date()
        }
      },
      {
        new: true
      }
    );


    if (!slot) {

      const existingSlot =
        await Slot.findById(slotId);

      if (!existingSlot) {
        return res.status(404).json({
          error: 'Slot not found'
        });
      }

      if (
        new Date(existingSlot.cutoffTime) <= new Date()
      ) {
        return res.status(400).json({
          error: 'Ordering is closed for this slot'
        });
      }

      return res.status(400).json({
        error: 'Not enough portions left'
      });
    }


    const newOrder = new Order({
      slotId,
      buyerName: buyerName.trim(),

      buyerPhone:
        buyerPhone
          ? buyerPhone.trim()
          : null,

      buyerEmail:
        buyerEmail
          ? buyerEmail.trim()
          : null,

      quantity: parsedQuantity,
      status: 'pending'
    });


    try {

      await newOrder.save();

    } catch (orderError) {

      /*
       * If order creation fails after the slot was
       * reserved, release the reserved quantity.
       */
      await Slot.findByIdAndUpdate(
        slotId,
        {
          $inc: {
            ordersCount: -parsedQuantity
          }
        }
      );

      throw orderError;
    }


    res.status(201).json(newOrder);

  } catch (err) {

    console.error('Place order error:', err);

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

    const orders = await Order
      .find({
        buyerName: req.params.buyerName
      })
      .sort({
        createdAt: -1
      });


    const withSlots =
      await Promise.all(

        orders.map(async order => {

          const slot =
            await Slot.findById(order.slotId);

          return {

            _id: order._id,

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

                  sellerName:
                    slot.sellerName,

                  mealType:
                    slot.mealType,

                  mealTime:
                    slot.mealTime,

                  cutoffTime:
                    slot.cutoffTime,

                  items:
                    slot.items,

                  pricePerPortion:
                    slot.pricePerPortion,

                  upiId:
                    slot.upiId,

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


    res.json(withSlots);

  } catch (err) {

    console.error('Buyer orders error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   SELLER ORDER QUEUE
========================================================= */

app.get('/api/orders/seller/:sellerName', async (req, res) => {
  try {

    const slots =
      await Slot.find({
        sellerName: req.params.sellerName
      });


    const slotIds =
      slots.map(s => s._id);


    const orders =
      await Order
        .find({
          slotId: {
            $in: slotIds
          }
        })
        .sort({
          createdAt: -1
        });


    const slotMap = {};

    slots.forEach(s => {
      slotMap[s._id.toString()] = s;
    });


    const result =
      orders.map(o => {

        const s =
          slotMap[o.slotId.toString()];


        return {

          _id:
            o._id,

          buyerName:
            o.buyerName,

          buyerPhone:
            o.buyerPhone,

          buyerEmail:
            o.buyerEmail,

          quantity:
            o.quantity,

          status:
            o.status,

          cancelReason:
            o.cancelReason,

          createdAt:
            o.createdAt,

          slot: s
            ? {

                _id:
                  s._id,

                mealType:
                  s.mealType,

                mealTime:
                  s.mealTime,

                cutoffTime:
                  s.cutoffTime,

                items:
                  s.items,

                pricePerPortion:
                  s.pricePerPortion

              }

            : null
        };
      });


    res.json(result);

  } catch (err) {

    console.error('Seller orders error:', err);

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
          `This order cannot be accepted because it is already ${order.status}`
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
      new Date(slot.cutoffTime) <= new Date()
    ) {
      return res.status(400).json({
        error:
          'This order can no longer be accepted because the ordering window has closed'
      });
    }


    if (
      slot.ordersCount > slot.maxPortions
    ) {
      return res.status(400).json({
        error:
          'This menu no longer has enough capacity'
      });
    }


    order.status = 'accepted';
    order.updatedAt = new Date();

    await order.save();


    res.json({
      success: true,
      message: 'Order accepted',
      order
    });

  } catch (err) {

    console.error('Accept order error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   REJECT ORDER
=========================================================

   IMPORTANT:
   Rejection is different from seller cancellation.

   Pending -> Rejected
   requires a reason.

   The reserved quantity is released.
========================================================= */

app.patch('/api/orders/:id/reject', async (req, res) => {
  try {

    const {
      reason
    } = req.body;


    if (
      !reason ||
      !reason.trim()
    ) {
      return res.status(400).json({
        error:
          'A rejection reason is required'
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
          'Only pending orders can be rejected'
      });
    }


    const slot =
      await Slot.findById(order.slotId);


    if (slot) {

      slot.ordersCount =
        Math.max(
          0,
          slot.ordersCount -
          order.quantity
        );

      slot.updatedAt = new Date();

      await slot.save();
    }


    order.status = 'rejected';
    order.cancelReason = reason.trim();
    order.updatedAt = new Date();

    await order.save();


    res.json({
      success: true,
      message: 'Order rejected',
      order
    });

  } catch (err) {

    console.error('Reject order error:', err);

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

    const {
      reason
    } = req.body;


    if (
      !reason ||
      !reason.trim()
    ) {
      return res.status(400).json({
        error:
          'A reason is required to cancel this order'
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
      ![
        'pending',
        'accepted'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error:
          'This order can no longer be cancelled'
      });
    }


    const slot =
      await Slot.findById(order.slotId);


    if (slot) {

      slot.ordersCount =
        Math.max(
          0,
          slot.ordersCount -
          order.quantity
        );

      slot.updatedAt =
        new Date();

      await slot.save();
    }


    order.status =
      'cancelled_by_seller';

    order.cancelReason =
      reason.trim();

    order.updatedAt =
      new Date();

    await order.save();


    res.json({
      success: true,
      message:
        'Order cancelled by seller',
      order
    });

  } catch (err) {

    console.error(
      'Seller cancel error:',
      err
    );

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   UPDATE ORDER QUANTITY
=========================================================

   Seller may ONLY increase quantity.

   This endpoint is intentionally restricted to:
       pending
       accepted

   It cannot reduce quantity.
========================================================= */

app.patch('/api/orders/:id', async (req, res) => {
  try {

    const {
      quantity
    } = req.body;


    if (
      !Number.isInteger(Number(quantity)) ||
      Number(quantity) < 1
    ) {
      return res.status(400).json({
        error:
          'Invalid quantity'
      });
    }


    const newQuantity =
      Number(quantity);


    const order =
      await Order.findById(req.params.id);


    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }


    if (
      ![
        'pending',
        'accepted'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error:
          'This order can no longer be edited'
      });
    }


    /*
     * Quantity can NEVER be reduced.
     */
    if (
      newQuantity <
      order.quantity
    ) {
      return res.status(400).json({
        error:
          'Order quantity can only be increased'
      });
    }


    if (
      newQuantity ===
      order.quantity
    ) {
      return res.json(order);
    }


    const increaseBy =
      newQuantity -
      order.quantity;


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
          'The ordering window has closed'
      });
    }


    /*
     * Atomic capacity check.
     */
    const updatedSlot =
      await Slot.findOneAndUpdate(

        {
          _id: slot._id,

          $expr: {
            $lte: [
              {
                $add: [
                  '$ordersCount',
                  increaseBy
                ]
              },
              '$maxPortions'
            ]
          }
        },

        {
          $inc: {
            ordersCount:
              increaseBy
          },

          $set: {
            updatedAt:
              new Date()
          }
        },

        {
          new: true
        }
      );


    if (!updatedSlot) {
      return res.status(400).json({
        error:
          'Not enough portions available for this increase'
      });
    }


    order.quantity =
      newQuantity;

    order.updatedAt =
      new Date();

    await order.save();


    res.json({
      success: true,
      message:
        'Order quantity increased',
      order
    });

  } catch (err) {

    console.error(
      'Update order error:',
      err
    );

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
      ![
        'pending',
        'accepted'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error:
          'This order cannot be cancelled'
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
          'Cannot cancel — ordering window has closed'
      });
    }


    const minutesSinceOrder =
      (
        new Date() -
        new Date(order.createdAt)
      ) / 60000;


    let refundPolicy =
      'full';


    if (
      minutesSinceOrder > 30
    ) {
      refundPolicy = 'none';

    } else if (
      minutesSinceOrder > 10
    ) {
      refundPolicy = 'half';
    }


    /*
     * Release reserved capacity.
     */
    slot.ordersCount =
      Math.max(
        0,
        slot.ordersCount -
        order.quantity
      );

    slot.updatedAt =
      new Date();

    await slot.save();


    /*
     * Preserve the order rather than deleting it.
     *
     * This becomes important later when we add
     * ratings, order history and seller/buyer
     * reputation.
     */
    order.status =
      'cancelled_by_buyer';

    order.cancelReason =
      `Buyer cancellation — refund policy: ${refundPolicy}`;

    order.updatedAt =
      new Date();

    await order.save();


    res.json({
      success: true,

      refundPolicy,

      minutesSinceOrder:
        Math.round(
          minutesSinceOrder
        ),

      order
    });

  } catch (err) {

    console.error(
      'Buyer cancellation error:',
      err
    );

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   SLOT COUNTDOWN
========================================================= */

app.get('/api/slots/:id/countdown', async (req, res) => {
  try {

    const slot =
      await Slot.findById(req.params.id);


    if (!slot) {
      return res.status(404).json({
        error: 'Slot not found'
      });
    }


    const msRemaining =
      new Date(slot.cutoffTime) -
      new Date();


    res.json({

      slotId:
        slot._id,

      isOpen:
        msRemaining > 0 &&
        slot.ordersCount <
        slot.maxPortions,

      minutesRemaining:
        Math.max(
          0,
          Math.floor(
            msRemaining /
            60000
          )
        ),

      portionsLeft:
        Math.max(
          0,
          slot.maxPortions -
          slot.ordersCount
        )
    });

  } catch (err) {

    res.status(500).json({
      error: err.message
    });
  }
});


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get('/', (req, res) => {
  res.send(
    'FoodTime backend is running!'
  );
});


/* =========================================================
   SERVER
========================================================= */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `FoodTime server running on port ${PORT}`
    );
  }
);
