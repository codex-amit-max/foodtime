mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');

    // Run maintenance after the server is fully loaded.
    setTimeout(async () => {
      try {
        await runMaintenance();
        console.log('Initial maintenance completed');
      } catch (err) {
        console.error('Initial maintenance error:', err.message);
      }
    }, 1000);

    // Run maintenance every hour.
    setInterval(async () => {
      try {
        await runMaintenance();
      } catch (err) {
        console.error('Scheduled maintenance error:', err.message);
      }
    }, 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
  });
/* =========================================================
   ACCEPT ORDER
   ========================================================= */

app.patch('/api/orders/:id/accept', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    // Only pending orders can be accepted.
    if (order.status !== 'pending') {
      return res.status(400).json({
        error: `This order is already ${order.status}.`
      });
    }

    const slot = await Slot.findById(order.slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    // Seller cannot accept after the ordering cutoff.
    if (new Date(slot.cutoffTime) <= new Date()) {
      return res.status(400).json({
        error: 'The ordering window has already closed.'
      });
    }

    order.status = 'accepted';

    // Keep a snapshot in case the menu is later removed.
    if (!order.slotSnapshot) {
      order.slotSnapshot = buildSlotSnapshot(slot);
    }

    await order.save();

    // Notify buyer.
    await notify(
      'buyer',
      order.buyerName,
      `Your order for "${slot.items}" was accepted!`,
      order._id,
      slot._id
    );

    res.json({
      success: true,
      message: 'Order accepted.',
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
   Mandatory rejection reason.
   ========================================================= */

app.patch('/api/orders/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        error: 'A rejection reason is required.'
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    // Only pending orders can be rejected.
    if (order.status !== 'pending') {
      return res.status(400).json({
        error: `This order is already ${order.status}.`
      });
    }

    const slot = await Slot.findById(order.slotId);

    if (slot) {
      // Return the rejected portions to availability.
      slot.ordersCount = Math.max(
        0,
        slot.ordersCount - order.quantity
      );

      await slot.save();
    }

    order.status = 'rejected';
    order.cancelReason = String(reason).trim();

    // Preserve menu information for buyer audit history.
    if (!order.slotSnapshot && slot) {
      order.slotSnapshot = buildSlotSnapshot(slot);
    }

    await order.save();

    // Notify buyer.
    if (slot) {
      await notify(
        'buyer',
        order.buyerName,
        `Your order for "${slot.items}" was rejected. Reason: ${String(reason).trim()}`,
        order._id,
        slot._id
      );
    }

    res.json({
      success: true,
      message: 'Order rejected.',
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
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        error: 'A reason is required to cancel this order.'
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    // An order that has already been rejected,
    // cancelled or timed out cannot be cancelled again.
    if (
      [
        'rejected',
        'timed_out',
        'cancelled_by_buyer',
        'cancelled_by_seller'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error: `This order is already ${order.status}.`
      });
    }

    const slot = await Slot.findById(order.slotId);

    if (slot) {
      // Return the portions to the available pool.
      slot.ordersCount = Math.max(
        0,
        slot.ordersCount - order.quantity
      );

      await slot.save();
    }

    order.status = 'cancelled_by_seller';
    order.cancelReason = String(reason).trim();

    // Preserve menu details for buyer audit history.
    if (!order.slotSnapshot && slot) {
      order.slotSnapshot = buildSlotSnapshot(slot);
    }

    await order.save();

    // Notify buyer.
    if (slot) {
      await notify(
        'buyer',
        order.buyerName,
        `Your order for "${slot.items}" was cancelled by the seller. Reason: ${String(reason).trim()}`,
        order._id,
        slot._id
      );
    }

    res.json({
      success: true,
      message: 'Order cancelled by seller.',
      order
    });

  } catch (err) {
    console.error('Seller cancellation error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});
/* =========================================================
   EDIT ORDER QUANTITY
   ========================================================= */

app.patch('/api/orders/:id', async (req, res) => {
  try {
    const { quantity } = req.body;

    if (!isValidQuantity(quantity)) {
      return res.status(400).json({
        error: 'Invalid quantity'
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    // Closed orders cannot be edited.
    if (
      [
        'rejected',
        'timed_out',
        'cancelled_by_buyer',
        'cancelled_by_seller'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error: 'Cannot edit a closed order.'
      });
    }

    const slot = await Slot.findById(order.slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    // Do not allow quantity changes after the ordering window closes.
    if (new Date(slot.cutoffTime) <= new Date()) {
      return res.status(400).json({
        error: 'The ordering window has closed.'
      });
    }

    const newQuantity = Number(quantity);
    const difference = newQuantity - order.quantity;

    // Make sure the new quantity fits within the menu capacity.
    if (slot.ordersCount + difference > slot.maxPortions) {
      return res.status(400).json({
        error: 'Not enough portions available for this change.'
      });
    }

    if (slot.ordersCount + difference < 0) {
      return res.status(400).json({
        error: 'Invalid quantity change.'
      });
    }

    slot.ordersCount += difference;

    await slot.save();

    order.quantity = newQuantity;

    await order.save();

    res.json({
      success: true,
      message: 'Order quantity updated successfully.',
      order
    });

  } catch (err) {
    console.error('Edit order error:', err);

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
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    // Closed orders cannot be cancelled again.
    if (
      [
        'rejected',
        'timed_out',
        'cancelled_by_buyer',
        'cancelled_by_seller'
      ].includes(order.status)
    ) {
      return res.status(400).json({
        error: `This order is already ${order.status}.`
      });
    }

    const slot = await Slot.findById(order.slotId);

    if (!slot) {
      return res.status(404).json({
        error: 'Menu not found'
      });
    }

    // Buyer cannot cancel after the ordering window closes.
    if (new Date(slot.cutoffTime) <= new Date()) {
      return res.status(400).json({
        error: 'Cannot cancel — ordering window has closed.'
      });
    }

    const minutesSinceOrder =
      (new Date() - new Date(order.createdAt)) / 60000;

    let refundPolicy = 'full';

    if (minutesSinceOrder > 30) {
      refundPolicy = 'none';
    } else if (minutesSinceOrder > 10) {
      refundPolicy = 'half';
    }

    // Return the portions to the menu.
    slot.ordersCount = Math.max(
      0,
      slot.ordersCount - order.quantity
    );

    await slot.save();

    // Keep the order for audit instead of deleting it.
    order.status = 'cancelled_by_buyer';
    order.cancelReason = 'Cancelled by buyer';

    if (!order.slotSnapshot) {
      order.slotSnapshot = buildSlotSnapshot(slot);
    }

    await order.save();

    // Notify seller.
    await notify(
      'seller',
      slot.sellerName,
      `${order.buyerName} cancelled their order for "${slot.items}" (${refundPolicy} refund applies).`,
      order._id,
      slot._id
    );

    res.json({
      success: true,
      refundPolicy,
      minutesSinceOrder: Math.round(minutesSinceOrder),
      order
    });

  } catch (err) {
    console.error('Buyer cancellation error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});
async function expireTimedOutOrders() {
  try {
    const now = new Date();

    // Find menus whose ordering window has closed.
    const slots = await Slot.find({
      cutoffTime: { $lte: now }
    });

    for (const slot of slots) {

      // ---------------------------------------------------------
      // 1. Convert all still-pending orders into timed_out.
      // ---------------------------------------------------------

      const pendingOrders = await Order.find({
        slotId: slot._id,
        status: 'pending'
      });

      for (const order of pendingOrders) {

        order.status = 'timed_out';

        order.cancelReason =
          'Seller did not accept the order before the ordering window closed.';

        // Preserve menu information for buyer audit history.
        if (!order.slotSnapshot) {
          order.slotSnapshot = buildSlotSnapshot(slot);
        }

        await order.save();

        // Notify buyer.
        await notify(
          'buyer',
          order.buyerName,
          `Your order for "${slot.items}" timed out because the seller did not accept it before the ordering window closed.`,
          order._id,
          slot._id
        );
      }

      // ---------------------------------------------------------
      // 2. Check whether this menu has any accepted orders.
      // ---------------------------------------------------------

      const acceptedOrderExists = await Order.exists({
        slotId: slot._id,
        status: 'accepted'
      });

      // ---------------------------------------------------------
      // 3. Check whether anything is still pending.
      // ---------------------------------------------------------

      const pendingOrderExists = await Order.exists({
        slotId: slot._id,
        status: 'pending'
      });

      // ---------------------------------------------------------
      // 4. Expired menu should disappear from marketplace.
      //
      // If there are no accepted orders and no pending orders,
      // remove the menu completely.
      //
      // Buyer order history is safe because slotSnapshot is stored
      // inside each order.
      // ---------------------------------------------------------

      if (!acceptedOrderExists && !pendingOrderExists) {
        await Slot.deleteOne({
          _id: slot._id
        });

        console.log(
          `Expired menu removed: ${slot._id}`
        );
      }
    }

  } catch (err) {
    console.error(
      'expireTimedOutOrders error:',
      err.message
    );
  }
}
