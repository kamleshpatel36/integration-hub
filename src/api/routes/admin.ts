import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import { seedPlans } from "../../services/seedService";

const router = Router();
router.use(requireAdmin);

// Exists specifically so plan-seeding doesn't require Shell access, which
// Render's Free tier doesn't include. Idempotent — safe to call more than
// once (e.g. after adding a new plan tier later).
router.post("/seed-plans", async (_req, res, next) => {
  try {
    const plans = await seedPlans();
    res.json({ seeded: plans });
  } catch (err) {
    next(err);
  }
});

export default router;
