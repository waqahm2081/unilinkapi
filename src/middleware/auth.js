import jwt from 'jsonwebtoken';

// Must match auth.js / StaffRoutes / PortalRoutes fallback when JWT_SECRET env is unset
const JWT_SECRET = process.env.JWT_SECRET || 'fgkjdfg890780we9fjsdkjsdyw39%^sdffsdfsddf';

function readBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

// Middleware to verify JWT token
export const authenticateToken = (req, res, next) => {
  const token = readBearerToken(req);

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        message: 'Token expired. Please login again.' 
      });
    }
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid token' 
    });
  }
};

/** Attach req.user when a valid Bearer token is present; otherwise continue as guest. */
export const optionalAuthenticate = (req, res, next) => {
  const token = readBearerToken(req);
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
};

// Middleware to check user role
export const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication required' 
      });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Insufficient permissions.' 
      });
    }
    
    next();
  };
};