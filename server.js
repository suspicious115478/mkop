const express = require('express');
const admin = require('firebase-admin');

// --- Firebase Admin SDK Initialization ---
// IMPORTANT: This expects FIREBASE_SERVICE_ACCOUNT_KEY and FIREBASE_DATABASE_URL
// to be set as environment variables on Render.
// DO NOT commit your serviceAccountKey.json file to your Git repository.

if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY || !process.env.FIREBASE_DATABASE_URL) {
    console.error("Critical Error: Missing Firebase environment variables.");
    console.error("Please ensure FIREBASE_SERVICE_ACCOUNT_KEY and FIREBASE_DATABASE_URL are set.");
    process.exit(1); // Exit the process if essential variables are missing
}

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    const firebaseDatabaseUrl = process.env.FIREBASE_DATABASE_URL;

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: firebaseDatabaseUrl
    });
    console.log("Firebase Admin SDK initialized successfully.");

} catch (error) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY or initialize Firebase Admin SDK:", error);
    process.exit(1); // Exit if initialization fails
}


// --- Express App Setup ---
const app = express();
// Render usually provides a PORT environment variable. If not, fallback to 10000.
const port = process.env.PORT || 10000;

// Middleware to parse JSON request bodies
app.use(express.json());

// --- Routes ---

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Call Server is running!');
});

// Endpoint for call acceptance notification from secondary apps
// This endpoint will be called by the Android app that accepts the call.
app.post('/api/callAccepted', async (req, res) => {
    const { userId, acceptedDeviceId, channel, token } = req.body;

    // Basic input validation
    if (!userId || !acceptedDeviceId || !channel || !token) {
        console.warn("Received /api/callAccepted request with missing fields:", req.body);
        return res.status(400).json({ error: 'Missing required fields: userId, acceptedDeviceId, channel, token' });
    }

    console.log(`[${new Date().toISOString()}] Received call accepted notification: User=${userId}, AcceptedBy=${acceptedDeviceId}, Channel=${channel}`);

    try {
        // 1. Get all secondary device tokens for this user from Firebase
        const secondaryDevicesRef = admin.database().ref(`/calls/${userId}/secondaryDevices`);
        const secondaryDevicesSnapshot = await secondaryDevicesRef.once('value');

        if (!secondaryDevicesSnapshot.exists()) {
            console.log(`[${new Date().toISOString()}] No secondary devices found for user ${userId}.`);
            return res.status(200).json({ message: 'No other devices to notify.' });
        }

        const secondaryDevices = secondaryDevicesSnapshot.val();
        const tokensToCancel = [];
        const deviceIdsToRemove = []; // To track invalid tokens for cleanup

        // 2. Filter out the accepting device's token and collect others
        for (const deviceId in secondaryDevices) {
            // Ensure it's an own property and not from prototype chain
            if (secondaryDevices.hasOwnProperty(deviceId)) {
                const deviceData = secondaryDevices[deviceId];
                const fcmToken = deviceData.fcmToken;

                if (fcmToken) {
                    if (deviceId !== acceptedDeviceId) {
                        // This token belongs to a device that *did not* accept the call
                        tokensToCancel.push(fcmToken);
                    }
                } else {
                    // Log if a device entry exists but has no FCM token
                    console.warn(`[${new Date().toISOString()}] Device ${deviceId} for user ${userId} has no FCM token.`);
                }
            }
        }

        if (tokensToCancel.length > 0) {
            console.log(`[${new Date().toISOString()}] Sending call_taken message to ${tokensToCancel.length} other devices for user ${userId}.`);

            // 3. Construct and Send FCM Messages
            const message = {
                data: {
                    type: 'call_taken',
                    channel: channel,
                    token: token // Although not strictly needed for cancellation, good for context
                },
                tokens: tokensToCancel, // Send to all filtered tokens

                // Android specific options for high priority
                android: {
                    priority: 'high',
                },
                // Optional: APNs (iOS) specific options for silent/high priority notification
                apns: {
                    headers: {
                        'apns-priority': '10' // High priority for iOS
                    },
                    payload: {
                        aps: {
                            content-available: 1, // For silent notifications that wake the app
                            // alert: { title: 'Call Ended', body: 'This call was answered elsewhere.' }, // Optional: for a subtle notification
                            sound: 'default' // This can sometimes help clear ongoing sounds on iOS
                        }
                    }
                },
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            console.log(`[${new Date().toISOString()}] FCM send result - Success: ${response.successCount}, Failures: ${response.failureCount}`);

            // Handle failed tokens: Identify and log (or remove from DB) invalid tokens
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const failedToken = tokensToCancel[idx];
                    console.error(`[${new Date().toISOString()}] Failed to send message to token ${failedToken}: ${resp.error?.message}`);
                    // Optionally, if the error indicates token is invalid (e.g., 'messaging/registration-token-not-registered'),
                    // you can add the deviceId associated with this token to a list for removal from your DB.
                    // This requires mapping token back to deviceId, which isn't directly available here.
                    // For now, just logging is a good start.
                }
            });

            return res.status(200).json({ message: 'FCM cancellation messages sent.', successCount: response.successCount, failureCount: response.failureCount });

        } else {
            console.log(`[${new Date().toISOString()}] No other devices to send cancellation to for user ${userId}.`);
            return res.status(200).json({ message: 'No other devices to notify.' });
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in /api/callAccepted for user ${userId}:`, error.message, error);
        return res.status(500).json({ error: `Server error processing call acceptance: ${error.message}` });
    }
});

// --- Server Startup ---
app.listen(port, () => {
    console.log(`[${new Date().toISOString()}] Call server listening on port ${port}`);
});