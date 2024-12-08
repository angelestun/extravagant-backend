const express = require('express');
const mysql = require('mysql');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webPush = require('web-push');
const app = express();


app.use(cors());
app.use(express.json());
const productUploadDir = path.join(__dirname, 'uploads', 'products');
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.head('/health', (req, res) => {
    res.status(200).end();
});


app.use(cors({
    origin: 'https://localhost:5173', 
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.head('/health', (req, res) => {
    res.status(200).end();
});

let pushSubscriptions = new Map();

const vapidKeys = {
    publicKey: 'BL8TL4HNOLqhA819AaYm7ifoluzHeabMLZtQjHnkpz_j95PxnTub_0u8lp2pG4vFXXIO01Uf6dTuXuFIjR-ctVM',
    privateKey: 'jMlkX1Tgpd6tqrAp9-qSbyMGWhT7kJPp4ZLd-BIYa5M',
    subject: 'mailto:xxxxx@gmail.com'
};


webPush.setVapidDetails(
    vapidKeys.subject,
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const checkVapidConfiguration = () => {
    const isConfigured = webPush.vapidDetails !== null;
    console.log('VAPID Configuration Status:', {
        isConfigured,
        details: webPush.vapidDetails
    });
    return isConfigured;
};

const getUserSubscriptions = (userId) => {
    const userSubs = [];
    for (const [endpoint, sub] of pushSubscriptions) {
        if (sub.userId === userId) {
            userSubs.push({ endpoint, subscription: sub });
        }
    }
    return userSubs;
};

const notifyUser = async (userId, notification) => {
    const userSubs = getUserSubscriptions(userId);
    let successCount = 0;

    for (const sub of userSubs) {
        try {
            const success = await sendPushNotification(sub.subscription, notification);
            if (success) {
                successCount++;
                sub.subscription.lastActivity = Date.now();
            }
        } catch (error) {
            console.error(`Error al notificar al usuario ${userId}:`, error);
        }
    }

    return successCount;
};

const promiseQuery = (sql, values) => {
    return new Promise((resolve, reject) => {
        connection.query(sql, values, (error, results) => {
            if (error) {
                reject(error);
            } else {
                resolve(results);
            }
        });
    });
};


const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '12345',
    database: 'zapateria2',
};

const connection = mysql.createConnection(dbConfig);

// Middleware de Conectividad - 
const connectivityMiddleware = (req, res, next) => {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');

    const isSyncRequest = req.headers['x-sync-request'];

    const originalSend = res.send;
    res.send = function(body) {

        if (res.statusCode >= 200 && res.statusCode < 300) {
            res.header('Cache-Control', 'public, max-age=300');
        }
        
       
        if (typeof body === 'object' && body !== null) {
            body._metadata = {
                timestamp: Date.now(),
                syncStatus: isSyncRequest ? 'synced' : 'realtime'
            };
        }
        
        return originalSend.call(this, body);
    };

    next();
};

const syncMiddleware = async (req, res, next) => {
    if (req.headers['x-sync-request'] === 'true') {
        console.log('Procesando solicitud de sincronización');
        try {
           
            const operations = req.body.operations || [];
            const results = [];

            for (const operation of operations) {
                let result;
                switch (operation.type) {
                    case 'ADD_TO_CART':
                        result = await executeQuery(
                            'INSERT INTO carrito_producto (ID_Carrito, ID_Producto, Cantidad) VALUES (?, ?, ?)',
                            [operation.data.ID_Carrito, operation.data.ID_Producto, operation.data.Cantidad]
                        );
                        break;
                    case 'UPDATE_QUANTITY':
                        result = await executeQuery(
                            'UPDATE carrito_producto SET Cantidad = ? WHERE ID_Carrito = ? AND ID_Producto = ?',
                            [operation.data.Cantidad, operation.data.ID_Carrito, operation.data.ID_Producto]
                        );
                        break;
                    case 'REMOVE_FROM_CART':
                        result = await executeQuery(
                            'DELETE FROM carrito_producto WHERE ID_Carrito = ? AND ID_Producto = ?',
                            [operation.data.ID_Carrito, operation.data.ID_Producto]
                        );
                        break;
                }
                results.push({ operation: operation.type, result });
            }

            res.locals.syncResults = results;
        } catch (error) {
            console.error('Error en sincronización:', error);
            return next(error);
        }
    }
    next();
};


const executeQuery = (query, params) => {
    return new Promise((resolve, reject) => {
        connection.query(query, params, (error, results) => {
            if (error) reject(error);
            else resolve(results);
        });
    });
};


app.use(connectivityMiddleware);
app.use(syncMiddleware);

// Endpoint de health check para PWA 
app.head('/api/health-check', (req, res) => {
    res.status(200).end();
});

app.head('/health', (req, res) => {
    res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*'
    }).status(200).end();
});

app.head('/ping', (req, res) => {
    res.status(200).end();
});

//#region notificaciones push

// Endpoint modificado para mejor manejo de usuarios
app.post('/subscribe', async (req, res) => {
    try {
        const { subscription, userId } = req.body;
        
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({ error: 'Suscripción inválida' });
        }

        if (!userId) {
            return res.status(400).json({ error: 'ID de usuario requerido' });
        }

        const userQuery = 'SELECT ID_Usuario FROM usuario WHERE ID_Usuario = ?';
        const userResult = await promiseQuery(userQuery, [userId]);

        if (userResult.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const existingSubs = getUserSubscriptions(userId);
        for (const sub of existingSubs) {
            pushSubscriptions.delete(sub.endpoint);
            console.log(`Suscripción antigua eliminada para usuario ${userId}`);
        }

        pushSubscriptions.set(subscription.endpoint, {
            ...subscription,
            userId,
            timestamp: Date.now(),
            lastActivity: Date.now(),
            userAgent: req.headers['user-agent']
        });

        console.log(`Nueva suscripción guardada:
            - Usuario: ${userId}
            - Endpoint: ${subscription.endpoint}
            - Total suscripciones: ${pushSubscriptions.size}`);

        const testNotification = {
            title: '¡Suscripción Exitosa! ✨',
            message: `Bienvenido a las notificaciones de Extravagant Style`,
            url: '/'
        };

        const success = await sendPushNotification(subscription, testNotification);

        if (success) {

            // Endpoint para verificar suscripciones de un usuario
            app.get('/api/user-subscriptions/:userId', (req, res) => {
                const { userId } = req.params;
                const userSubs = getUserSubscriptions(userId);
                res.json({
                    userId,
                    subscriptionCount: userSubs.length,
                    subscriptions: userSubs.map(sub => ({
                        endpoint: sub.endpoint,
                        lastActivity: sub.subscription.lastActivity
                    }))
                });
            });

            res.status(201).json({
                message: 'Suscripción registrada exitosamente',
                userId: userId,
                endpoint: subscription.endpoint,
                subscriptionCount: pushSubscriptions.size
            });
        } else {
            throw new Error('Error al enviar notificación de prueba');
        }

    } catch (error) {
        console.error('Error en suscripción:', error);
        res.status(500).json({ error: 'Error al registrar suscripción' });
    }
});


const sendPushNotification = async (subscription, data) => {
    if (!subscription || !subscription.endpoint) {
        console.log('Suscripción inválida:', subscription);
        return false;
    }

    try {
        // Asegurar que el mensaje sea string y no un objeto
        const messageText = typeof data.message === 'object' ? 
            JSON.stringify(data.message) : 
            String(data.message || '');

        // Construir un payload más simple y directo
        const payload = JSON.stringify({
            notification: {
                title: String(data.title || 'Extravagant Style'),
                body: messageText, // Usar messageText directamente como body
                icon: '/icon-192x192.png',
                badge: '/icon-192x192.png',
                vibrate: [100, 50, 100],
                data: {
                    url: data.url || '/',
                    dateOfArrival: Date.now(),
                },
                requireInteraction: true,
                actions: [
                    {
                        action: 'open',
                        title: 'Ver más'
                    }
                ]
            }
        });

        console.log('Enviando notificación:', JSON.parse(payload));

        await webPush.sendNotification(
            subscription,
            payload,
            {
                urgency: 'high',
                TTL: 3600
            }
        );

        return true;
    } catch (error) {
        console.error('Error al enviar notificación:', error);
        if (error.statusCode === 410 || error.statusCode === 404) {
            pushSubscriptions.delete(subscription.endpoint);
        }
        return false;
    }
};

// Endpoint para limpiar las suscripciones inactivas
const cleanSubscriptions = async () => {
    const validSubscriptions = new Map();
    
    for (const [endpoint, subscription] of pushSubscriptions) {
        try {
            await webPush.sendNotification(
                subscription,
                JSON.stringify({
                    title: 'Test Notification',
                    message: 'Verificando suscripción'
                }),
                { 
                    urgency: 'high',
                    TTL: 10
                }
            );
            validSubscriptions.set(endpoint, subscription);
        } catch (error) {
            console.log('Eliminando suscripción inválida:', endpoint);
        }
    }
    
    pushSubscriptions = validSubscriptions;
    console.log(`Suscripciones activas después de limpieza: ${pushSubscriptions.size}`);
};

const maintainSubscriptions = () => {
    setInterval(async () => {
        console.log('Iniciando mantenimiento de suscripciones...');
        await cleanSubscriptions();
    }, 30 * 60 * 1000); 
};

maintainSubscriptions();

const notifyNewOffer = async (productInfo, offerType, discount) => {
    try {
        if (!productInfo || !productInfo.Nombre_Producto) {
            console.error('Información del producto incompleta');
            return 0;
        }

        const messageText = offerType === '2x1' 
            ? `¡2x1 en ${productInfo.Nombre_Producto}! 🛍️`
            : `¡${discount}% OFF en ${productInfo.Nombre_Producto}! 💫`;

        const notificationPayload = {
            title: '¡Nueva Oferta Disponible! 🎉',
            message: messageText,
            url: '/lista-Productos'
        };

        // Enviar a todos los usuarios suscritos
        let successCount = 0;
        for (const [_, subscription] of pushSubscriptions) {
            try {
                const success = await sendPushNotification(subscription, notificationPayload);
                if (success) {
                    successCount++;
                    subscription.lastActivity = Date.now();
                }
            } catch (error) {
                console.error('Error al enviar notificación:', error);
            }
        }

        return successCount;
    } catch (error) {
        console.error('Error en notifyNewOffer:', error);
        return 0;
    }
};

app.get('/debug-notifications', (req, res) => {
    res.json({
        totalSubscriptions: pushSubscriptions.length,
        vapidConfigured: true,
        vapidDetails: {
            subject: vapidKeys.subject,
            publicKeySet: !!vapidKeys.publicKey,
            privateKeySet: !!vapidKeys.privateKey
        },
        subscriptions: pushSubscriptions.map(sub => ({
            endpoint: sub.endpoint,
            hasValidKeys: !!(sub.keys && sub.keys.p256dh && sub.keys.auth)
        }))
    });
});


//#endregion

// Endpoint para sincronización 
app.post('/api/sync', async (req, res) => {
    try {
        const syncResults = res.locals.syncResults || [];
        res.json({
            success: true,
            message: 'Sincronización completada',
            results: syncResults
        });
    } catch (error) {
        console.error('Error en sincronización:', error);
        res.status(500).json({
            success: false,
            message: 'Error en la sincronización',
            error: error.message
        });
    }
});

// Conexión a la base de datos
connection.connect((err) => {
    if (err) {
        console.error("Error de conexión: ", err);
    } else {
        console.log("Conexión a la base de datos realizada!");
    }
});

// Función para ejecutar consultas
const queryDatabase = (query, params) => {
    return new Promise((resolve, reject) => {
        connection.query(query, params, (error, results) => {
            if (error) {
                return reject(error);
            }
            resolve(results);
        });
    });
};


//#region CRUD USUARIOS

app.post('/registro', async (req, res) => {
    const { Nombre, Apellido, Correo, Contraseña, Rol } = req.body;

    
    let ID_Rol = Rol === "vendedor" ? 2 : 1;

  
    const query = 'INSERT INTO usuario (Nombre, Apellido, Correo, Contraseña, ID_Rol) VALUES (?, ?, ?, ?, ?)';
    
    connection.query(query, [Nombre, Apellido, Correo, Contraseña, ID_Rol], (err, results) => {
        if (err) {
            console.error("Error al registrar usuario: ", err);
            return res.status(500).json({ error: err.message || "Error al registrar usuario" });
        }

        const ID_Usuario = results.insertId; 

      
        res.json({
            message: "Usuario registrado con éxito",
            user: {
                ID_Usuario,
                Nombre,
                Apellido,
                Correo,
                ID_Rol
            }
        });
    });
});

app.post('/login', (req, res) => {
    const { Correo, Contraseña } = req.body;

    const query = 'SELECT * FROM usuario WHERE Correo = ?';
    connection.query(query, [Correo], (err, results) => {
        if (err) {
            return res.status(500).json({ error: "Error en la conexión a la base de datos" });
        }
        if (results.length === 0) {
            return res.status(401).json({ error: "Credenciales inválidas" });
        }

        const usuario = results[0];

      
        if (Contraseña !== usuario.Contraseña) {
            return res.status(401).json({ error: "Credenciales inválidas" });
        }

        let rol;
        switch (usuario.ID_Rol) {
            case 1:
                rol = "admin";
                break;
            case 2:
                rol = "vendedor";
                break;
            default:
                rol = "usuario";
        }

        res.json({ 
            usuario: { 
                Correo: usuario.Correo,
                ID_Usuario: usuario.ID_Usuario,
                Rol: rol 
            } 
        });
    });
});

// GET - Obtener todos los usuarios
app.get('/usuarios', (req, res) => {
    const query = 'SELECT * FROM Usuario';

    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener usuarios: ", err);
            res.status(500).json({ error: "Error al obtener usuarios" });
            return;
        }
        res.status(200).json(results);
    });
});

// GET - Obtener un usuario por ID
app.get('/usuarios/:id', (req, res) => {
    const { id } = req.params;
    const query = 'SELECT * FROM Usuario WHERE ID_Usuario = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al obtener usuario: ", err);
            res.status(500).json({ error: "Error al obtener usuario" });
            return;
        } else if (results.length === 0) {
            res.status(404).json({ error: "Usuario no encontrado" });
            return;
        }
        res.status(200).json(results[0]);
    });
});

// PUT - Actualizar un usuario existente
app.put('/usuarios/:id', (req, res) => {
    const { id } = req.params;
    const { Nombre, Apellido, Correo, Contraseña } = req.body;
    const query = 'UPDATE Usuario SET Nombre = ?, Apellido = ?, Correo = ?, Contraseña = ? WHERE ID_Usuario = ?';

    connection.query(query, [Nombre, Apellido, Correo, Contraseña, id], (err, results) => {
        if (err) {
            console.error("Error al actualizar usuario: ", err);
            res.status(500).json({ error: "Error al actualizar usuario" });
            return;
        } else if (results.affectedRows === 0) {
            res.status(404).json({ error: "Usuario no encontrado" });
            return;
        }
        res.status(200).json({ message: "Usuario actualizado con éxito" });
    });
});

// DELETE - Eliminar un usuario existente
app.delete('/usuarios/:id', (req, res) => {
    const { id } = req.params;

 
    const deleteOrdersQuery = 'DELETE FROM Pedidos WHERE ID_Usuario = ?';
    connection.query(deleteOrdersQuery, [id], (err) => {
        if (err) {
            console.error("Error al eliminar pedidos: ", err);
            res.status(500).json({ error: "Error al eliminar pedidos del usuario" });
            return;
        }

        const deleteUserQuery = 'DELETE FROM Usuario WHERE ID_Usuario = ?';
        connection.query(deleteUserQuery, [id], (err, results) => {
            if (err) {
                console.error("Error al eliminar usuario: ", err);
                res.status(500).json({ error: "Error al eliminar usuario" });
                return;
            } else if (results.affectedRows === 0) {
                res.status(404).json({ error: "Usuario no encontrado" });
                return;
            }

            res.status(200).json({ message: "Usuario y sus pedidos eliminados con éxito" });
        });
    });
});

//#region CRUD PRODUCTOS
const productStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, productUploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const uploadProduct = multer({ storage: productStorage });
app.use('/uploads/products', express.static(productUploadDir));

const productsByStore = new Map();
let notificationInterval = null;

const sendGroupedNotification = async () => {
    try {
        for (const [tiendaId, productos] of productsByStore.entries()) {
            if (productos.length === 0) continue;

            const [tienda] = await promiseQuery(
                'SELECT NombreTienda FROM tienda WHERE ID_Tienda = ?',
                [tiendaId]
            );

            if (!tienda) continue;

            const notificationData = {
                notification: {
                    title: productos.length === 1 
                        ? `¡Nuevo producto en ${tienda.NombreTienda}! 🆕` 
                        : `¡Nuevos productos en ${tienda.NombreTienda}! 🆕`,
                    body: productos.length === 1 
                        ? `${productos[0].Nombre_Producto} ya está disponible` 
                        : `${productos.length} nuevos productos disponibles`,
                    icon: '/icon-192x192.png',
                    badge: '/icon-192x192.png',
                    data: {
                        url: '/lista-productos',
                        tiendaId: tiendaId
                    }
                }
            };

            for (const [_, subscription] of pushSubscriptions) {
                try {
                    await sendPushNotification(subscription, notificationData);
                } catch (error) {
                    console.error('Error al enviar notificación:', error);
                }
            }
        }

        productsByStore.clear();

    } catch (error) {
        console.error('Error al enviar notificaciones agrupadas:', error);
    }
};

// Endpoint para registrar productos
app.post('/productos', uploadProduct.single('Imagen'), async (req, res) => {
    console.log(req.body);
    console.log(req.file);

    const { Nombre_Producto, Descripcion, Precio, Stock, Talla, Color, Categoria, Marca } = req.body;
    const ID_Tienda = req.body.ID_Tienda;
    const ID_Usuario = req.body.ID_Usuario;
    const imagen = req.file ? req.file.originalname : null;

    if (!Nombre_Producto || !Descripcion || !Precio || !Stock || !Talla || !Color || !Categoria || !ID_Tienda || !ID_Usuario || !imagen || !Marca) {
        return res.status(400).json({ error: "Todos los campos son requeridos." });
    }

    try {
        const query = 'INSERT INTO Producto (Nombre_Producto, Descripcion, Precio, Stock, Talla, Color, Imagen, Categoria, ID_Tienda, ID_Usuario, Marca) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        await promiseQuery(query, [
            Nombre_Producto, Descripcion, Precio, Stock, Talla, Color, 
            imagen, Categoria, ID_Tienda, ID_Usuario, Marca
        ]);

        if (!productsByStore.has(ID_Tienda)) {
            productsByStore.set(ID_Tienda, []);
        }
        productsByStore.get(ID_Tienda).push({
            Nombre_Producto,
            ID_Tienda
        });

        if (!notificationInterval) {
            notificationInterval = setInterval(() => {
                if (productsByStore.size > 0) {
                    sendGroupedNotification();
                }
            }, 30 * 60 * 1000); 
        }

        res.status(201).json({ message: "Producto agregado con éxito" });
    } catch (err) {
        console.error("Error al agregar producto: ", err);
        res.status(500).json({ error: "Error al agregar producto" });
    }
});

process.on('SIGINT', () => {
    if (notificationInterval) {
        clearInterval(notificationInterval);
    }
    process.exit();
});

// Limpiar el intervalo cuando se apague el servidor
process.on('SIGINT', () => {
    if (notificationInterval) {
        clearInterval(notificationInterval);
    }
    process.exit();
});

//GET - Obtener productos por tienda
app.get('/productos/tienda', (req, res) => {
    const { ID_Usuario, ID_Tienda } = req.query;
    console.log("ID_Usuario:", ID_Usuario);
    console.log("ID_Tienda:", ID_Tienda);

    if (!ID_Usuario || !ID_Tienda) {
        return res.status(400).json({ error: "ID_Usuario y ID_Tienda son requeridos" });
    }

    const query = 'SELECT * FROM Producto WHERE ID_Usuario = ? AND ID_Tienda = ?';
    connection.query(query, [ID_Usuario, ID_Tienda], (err, results) => {
        if (err) {
            console.error("Error al obtener productos: ", err);
            return res.status(500).json({ error: "Error al obtener productos" });
        }
        res.status(200).json(results);
    });
});



// PUT - Actualizar Producto
app.put('/productos/:id', uploadProduct.single('Imagen'), (req, res) => {
    const { id } = req.params;
    const { Nombre_Producto, Descripcion, Precio, Stock, Talla, Color, Categoria } = req.body;
    const ID_Tienda = req.body.ID_Tienda; 
    const imagenPath = req.file ? req.file.originalname : null;

    if (!Nombre_Producto || !Descripcion || !Precio || !Stock || !Talla || !Color || !Categoria || !ID_Tienda) {
        return res.status(400).json({ error: "Todos los campos son requeridos." });
    }

    const query = 'UPDATE Producto SET Nombre_Producto = ?, Descripcion = ?, Precio = ?, Stock = ?, Talla = ?, Color = ?, Imagen = ?, Categoria = ?, ID_Tienda = ? WHERE ID_Producto = ?';
    connection.query(query, [Nombre_Producto, Descripcion, Precio, Stock, Talla, Color, imagenPath, Categoria, ID_Tienda, id], (err, results) => {
        if (err) {
            console.error("Error al actualizar producto: ", err);
            return res.status(500).json({ error: "Error al actualizar producto" });
        } else if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }
        res.status(200).json({ message: "Producto actualizado con éxito" });
    });
});

// Eliminar Producto
app.delete('/productos/:id', (req, res) => {
    const { id } = req.params;

    const checkQuery = 'SELECT * FROM Producto WHERE ID_Producto = ?';
    connection.query(checkQuery, [id], (checkErr, checkResults) => {
        if (checkErr) {
            console.error("Error al verificar producto: ", checkErr);
            return res.status(500).json({ error: "Error al verificar producto" });
        }
        if (checkResults.length === 0) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }

        const query = 'DELETE FROM Producto WHERE ID_Producto = ?';
        connection.query(query, [id], (err, results) => {
            if (err) {
                console.error("Error al eliminar producto: ", err);
                return res.status(500).json({ error: "Error al eliminar producto" });
            }
            res.status(200).json({ message: "Producto eliminado con éxito" });
        });
    });
});


//Vista clientes

// GET - Obtener todos los productos
app.get('/productos/all', (req, res) => {
    const query = 'SELECT * FROM Producto';
    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener productos: ", err);
            return res.status(500).json({ error: "Error al obtener productos" });
        }
        res.status(200).json(results);
    });
});

//GET - Obtener los productos por tienda
app.get('/producto/tienda', (req, res) => {
    const { ID_Tienda } = req.query; 
    console.log("ID_Tienda:", ID_Tienda);

    if (!ID_Tienda) {
        return res.status(400).json({ error: "ID_Tienda es requerido" });
    }

    const query = 'SELECT * FROM Producto WHERE ID_Tienda = ?';
    connection.query(query, [ID_Tienda], (err, results) => {
        if (err) {
            console.error("Error al obtener productos: ", err);
            return res.status(500).json({ error: "Error al obtener productos" });
        }
        res.status(200).json(results);
    });
});

//#endregion


//#region CRUD PEDIDOS

// GET - Obtener todos los pedidos
app.get('/pedidos', (req, res) => {
    connection.query("SELECT * FROM pedidos", (err, rows) => {
        if (err) {
            console.error("Error en la consulta: ", err);
            return res.status(500).json({ error: 'Error en la consulta' });
        }
        res.json(rows);
    });
});

// GET - Obtener un pedido por ID
app.get('/pedidos/:id', (req, res) => {
    const id = req.params.id;
    connection.query("SELECT * FROM pedidos WHERE ID_Pedido = ?", [id], (err, row) => {
        if (err) {
            console.error("Error en la consulta: ", err);
            return res.status(500).json({ error: 'Error en la consulta' });
        } else if (row.length === 0) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }
        res.json(row[0]);
    });
});

// POST - Agregar un nuevo pedido
app.post('/pedidos', (req, res) => {
    const { ID_Usuario, Direccion_Envio, Metodo_Pago, Notas, ID_Cupon } = req.body;
    connection.query(
        "INSERT INTO pedidos (ID_Usuario, Fecha_Pedido, Estado_Pedido, Total, Direccion_Envio, Metodo_Pago, Notas, ID_Cupon, Monto_Descuento) VALUES (?, NOW(), 'Pendiente', 0, ?, ?, ?, ?)",
        [ID_Usuario, Direccion_Envio, Metodo_Pago, Notas, ID_Cupon],
        (err, result) => {
            if (err) {
                console.error("Error en la consulta: ", err);
                return res.status(500).json({ error: 'Error al agregar pedido' });
            }
            res.status(201).json({ message: 'Pedido agregado correctamente', id: result.insertId });
        }
    );
});

// PUT - Actualizar un pedido existente
app.put('/pedidos/:id', (req, res) => {
    const id = req.params.id;
    const { Estado_Pedido, Direccion_Envio, Metodo_Pago, Notas, Monto_Descuento } = req.body;
    connection.query(
        "UPDATE pedidos SET Estado_Pedido = ?, Direccion_Envio = ?, Metodo_Pago = ?, Notas = ?, Monto_Descuento = ? WHERE ID_Pedido = ?",
        [Estado_Pedido, Direccion_Envio, Metodo_Pago, Notas, Monto_Descuento, id],
        (err, result) => {
            if (err) {
                console.error("Error en la consulta: ", err);
                return res.status(500).json({ error: 'Error al actualizar pedido' });
            } else if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }
            res.json({ message: 'Pedido actualizado correctamente' });
        }
    );
});

// DELETE - Eliminar un pedido existente
app.delete('/pedidos/:id', (req, res) => {
    const id = req.params.id;
    connection.query(
        "DELETE FROM pedidos WHERE ID_Pedido = ?",
        [id],
        (err, result) => {
            if (err) {
                console.error("Error en la consulta: ", err);
                return res.status(500).json({ error: 'Error al eliminar pedido' });
            } else if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }
            res.json({ message: 'Pedido eliminado correctamente' });
        }
    );
});

//#endregion


//#region CRUD DETALLE PEDIDO

// GET - Obtener todos los detalles de pedidos
app.get('/pedido_producto', (req, res) => {
    connection.query("SELECT * FROM pedido_producto", (err, rows) => {
        if (err) {
            console.error("Error en la consulta: ", err);
            res.status(500).send('Error en la consulta');
        } else {
            res.json(rows);
        }
    });
});

// GET - Obtener un detalle de pedido por ID
app.get('/pedido_producto/detalle/:id', (req, res) => {
    const id = req.params.id;
    connection.query("SELECT * FROM pedido_producto WHERE ID_Pedido = ?", [id], (err, row) => {
        if (err) {
            console.error("Error en la consulta: ", err);
            res.status(500).send('Error en la consulta');
        } else if (row.length === 0) {
            res.status(404).send('Detalle de pedido no encontrado');
        } else {
            res.json(row[0]);
        }
    });
});

// GET - Obtener un detalle de pedido por ID con productos y nombre de la tienda
app.get('/pedido_producto/:id', (req, res) => {
    const id = req.params.id;

    const pedidoQuery = "SELECT * FROM pedido_producto WHERE ID_Pedido = ?";
    connection.query(pedidoQuery, [id], (err, pedidoRow) => {
        if (err) {
            console.error("Error en la consulta: ", err);
            return res.status(500).send('Error en la consulta');
        } else if (pedidoRow.length === 0) {
            return res.status(404).send('Detalle de pedido no encontrado');
        }

       
        const productosQuery = `
            SELECT 
                p.ID_Producto, 
                p.Nombre_Producto, 
                pp.Cantidad, 
                pp.Precio_Unitario, 
                t.NombreTienda
            FROM 
                pedido_producto pp
            JOIN 
                producto p ON pp.ID_Producto = p.ID_Producto
            JOIN 
                tienda t ON p.ID_Tienda = t.ID_Tienda 
            WHERE 
                pp.ID_Pedido = ?
        `;
        connection.query(productosQuery, [pedidoRow[0].ID_Pedido], (err, productosRows) => {
            if (err) {
                console.error("Error al obtener los productos: ", err);
                return res.status(500).send('Error al obtener los productos');
            } else if (productosRows.length === 0) {
                return res.status(404).send('No se encontraron productos para este pedido');
            }

           
            const response = {
                pedido: pedidoRow[0], 
                productos: productosRows 
            };

            res.json(response); 
        });
    });
});


// POST - Agregar un nuevo detalle de pedido
app.post('/pedido_producto', (req, res) => {
    const { ID_Pedido, ID_Producto, Cantidad, Precio_Unitario } = req.body;
    connection.query(
        "INSERT INTO pedido_producto (ID_Pedido, ID_Producto, Cantidad, Precio_Unitario) VALUES (?, ?, ?, ?)",
        [ID_Pedido, ID_Producto, Cantidad, Precio_Unitario],
        (err, result) => {
            if (err) {
                console.error("Error en la consulta: ", err);
                res.status(500).send('Error al agregar detalle de pedido');
            } else {
                res.status(201).send('Detalle de pedido agregado correctamente');
            }
        }
    );
});

// PUT - Actualizar un detalle de pedido existente
app.put('/pedido_producto/:id', (req, res) => {
    const id = req.params.id;
    const { ID_Pedido, ID_Producto, Cantidad, Precio_Unitario } = req.body;
    connection.query(
        "UPDATE pedido_producto SET ID_Pedido = ?, ID_Producto = ?, Cantidad = ?, Precio_Unitario = ? WHERE ID_Pedido_Producto = ?",
        [ID_Pedido, ID_Producto, Cantidad, Precio_Unitario, id],
        (err, result) => {
            if (err) {
                console.error("Error en la consulta: ", err);
                res.status(500).send('Error al actualizar detalle de pedido');
            } else if (result.affectedRows === 0) {
                res.status(404).send('Detalle de pedido no encontrado');
            } else {
                res.send('Detalle de pedido actualizado correctamente');
            }
        }
    );
});

// DELETE - Eliminar un detalle de pedido existente
app.delete('/pedido_producto/:id', (req, res) => {
    const id = req.params.id;
    connection.query(
        "DELETE FROM pedido_producto WHERE ID_Pedido_Producto = ?",
        [id],
        (err, result) => {
            if (err) {
                console.error("Error en la consulta: ", err);
                res.status(500).send('Error al eliminar detalle de pedido');
            } else if (result.affectedRows === 0) {
                res.status(404).send('Detalle de pedido no encontrado');
            } else {
                res.send('Detalle de pedido eliminado correctamente');
            }
        }
    );
});
//#endregion

//#region CRUD Ofertas
app.post('/createofertas', async (req, res) => {
    const { Descuento, Fecha_Fin, Fecha_Inicio, Activo, ID_Usuario, ID_Tienda, ID_Producto, Tipo_Oferta, Cantidad_Requerida } = req.body;

    if (!ID_Usuario || !ID_Tienda || !ID_Producto) {
        return res.status(400).json({ error: "ID de usuario, ID de tienda y ID de producto son requeridos" });
    }

    try {
        const productInfo = await promiseQuery(
            'SELECT ID_Producto, Nombre_Producto FROM Producto WHERE ID_Producto = ?',
            [ID_Producto]
        );

        if (!productInfo || productInfo.length === 0) {
            return res.status(404).json({ error: "Producto no encontrado" });
        }

        // Insertar la oferta
        const query = `
            INSERT INTO ofertas (
                Descuento, Fecha_Fin, Fecha_Inicio, Activo, 
                Fecha_Creacion, ID_Usuario, ID_Tienda, ID_Producto, 
                Tipo_Oferta, Cantidad_Requerida
            ) 
            VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`;
        
        const results = await promiseQuery(query, [
            Descuento, Fecha_Fin, Fecha_Inicio, Activo, 
            ID_Usuario, ID_Tienda, ID_Producto, Tipo_Oferta, 
            Cantidad_Requerida
        ]);

        const notificationsSent = await notifyNewOffer(productInfo[0], Tipo_Oferta, Descuento);

        res.status(201).json({ 
            message: "Oferta registrada con éxito", 
            id: results.insertId,
            notificationsSent: notificationsSent > 0,
            notificationCount: notificationsSent
        });
    } catch (err) {
        console.error("Error detallado:", err);
        res.status(500).json({ error: err.message || "Error al registrar oferta" });
    }
});

// GET - Obtener todas las ofertas de una tienda
app.get('/oferta/tienda/:idTienda', async (req, res) => {
    const idTienda = req.params.idTienda;
    const query = 'SELECT * FROM ofertas WHERE ID_Tienda = ?'; 

    connection.query(query, [idTienda], (err, results) => { 
        if (err) {
            console.error("Error al obtener ofertas: ", err);
            return res.status(500).json({ error: "Error al obtener ofertas" });
        }
        res.status(200).json(results); 
    });
});

// PUT - Actualizar una oferta
app.put('/ofertas/:idOferta', async (req, res) => {
    const idOferta = req.params.idOferta;
    const { ID_Producto, Fecha_Inicio, Fecha_Fin, Descuento, Tipo_Oferta, Cantidad_Requerida, ID_Tienda } = req.body;

    if (!ID_Producto || !Fecha_Inicio || !Fecha_Fin) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    if (Tipo_Oferta === '2x1' && (!Cantidad_Requerida || Cantidad_Requerida <= 0)) {
        return res.status(400).json({ error: "La 'Cantidad_Requerida' debe ser un número mayor a 0 para el tipo de oferta '2x1'." });
    }

    if (Tipo_Oferta === 'Descuento') {
        const activeDiscounts = await new Promise((resolve, reject) => {
            connection.query('SELECT COUNT(*) as count FROM ofertas WHERE ID_Tienda = ? AND Tipo_Oferta = "Descuento" AND Activo = 1 AND ID_Oferta != ?', [ID_Tienda, idOferta], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (activeDiscounts[0].count >= 100) {
            return res.status(400).json({ error: "No se pueden tener más de 100 descuentos activos." });
        }
    }

    const query = `
        UPDATE ofertas 
        SET 
            ID_Producto = ?, 
            Fecha_Inicio = ?, 
            Fecha_Fin = ?, 
            Descuento = ?, 
            Tipo_Oferta = ?, 
            Cantidad_Requerida = ? 
        WHERE ID_Oferta = ?`;

    const values = [ID_Producto, Fecha_Inicio, Fecha_Fin, Descuento || null, Tipo_Oferta || null, Cantidad_Requerida || null, idOferta];

    connection.query(query, values, (err, results) => {
        if (err) {
            console.error("Error al actualizar oferta: ", err);
            return res.status(500).json({ error: "Error al actualizar oferta" });
        }
        res.status(200).json({ message: "Oferta actualizada exitosamente" });
    });
});


// DELETE - Eliminar una oferta existente
app.delete('/ofertas/:id', (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM ofertas WHERE ID_Oferta = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al eliminar oferta: ", err);
            res.status(500).json({ error: "Error al eliminar oferta" });
            return;
        } else if (results.affectedRows === 0) {
            res.status(404).json({ error: "Oferta no encontrada" });
            return;
        }
        res.status(200).json({ message: "Oferta eliminada con éxito" });
    });
});


// GET - Obtener el carrito de un usuario con información de ofertas
app.get('/carrito/:userId', async (req, res) => {
    const userId = req.params.userId;

    
    const query = `
        SELECT cp.*, o.Descuento, o.Tipo_Oferta, o.Cantidad_Requerida, p.Nombre_Producto, p.Imagen, t.NombreTienda
        FROM carrito c
        JOIN carrito_producto cp ON c.ID_Carrito = cp.ID_Carrito
        LEFT JOIN ofertas o ON cp.ID_Producto = o.ID_Producto 
        LEFT JOIN producto p ON cp.ID_Producto = p.ID_Producto
        LEFT JOIN tienda t ON p.ID_Tienda = t.ID_Tienda
        WHERE c.ID_Usuario = ? 
        AND (o.Activo = 1 AND NOW() BETWEEN o.Fecha_Inicio AND o.Fecha_Fin)
    `;

    connection.query(query, [userId], (err, results) => {
        if (err) {
            console.error("Error al obtener el carrito: ", err);
            return res.status(500).json({ error: "Error al obtener el carrito" });
        }
        res.status(200).json(results);
    });
});


// GET - Obtener todos los productos de una tienda
app.get('/producto/tienda/:idTienda', (req, res) => {
    const idTienda = req.params.idTienda;
    const query = 'SELECT * FROM producto WHERE ID_Tienda = ?'; 
    connection.query(query, [idTienda], (err, results) => { 
        if (err) {
            console.error("Error al obtener productos: ", err);
            return res.status(500).json({ error: "Error al obtener productos" });
        }
        res.status(200).json(results);
    });
});

// PATCH - Activar o desactivar una oferta
app.patch('/ofertas/:id/toggle', (req, res) => {
    const { id } = req.params;
    const query = 'UPDATE ofertas SET Activo = NOT Activo WHERE ID_Oferta = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al activar/desactivar oferta: ", err);
            return res.status(500).json({ error: "Error al activar/desactivar oferta" });
        } else if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Oferta no encontrada" });
        }
        res.status(200).json({ message: "Estado de la oferta actualizado con éxito" });
    });
});



// PUT - Activar ofertas que ya han alcanzado su fecha de inicio
const activarOfertas = () => {
    const query = 'UPDATE ofertas SET Activo = 1 WHERE Fecha_Inicio <= NOW() AND Activo = 0';

    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al activar ofertas: ", err);
        } else {
            console.log(`${results.affectedRows} ofertas activadas con éxito`);
        }
    });
};

// PUT - Desactivar ofertas que han pasado su fecha de fin
const desactivarOfertas = () => {
    const query = 'UPDATE ofertas SET Activo = 0 WHERE Fecha_Fin < NOW() AND Activo = 1';

    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al desactivar ofertas: ", err);
        } else {
            console.log(`${results.affectedRows} ofertas desactivadas con éxito`);
        }
    });
};

setInterval(() => {
    activarOfertas();
    desactivarOfertas(); 
}, 10 * 60 * 1000); 

//#endregion

//#region CRUD Cupones

// POST - Registrar un nuevo cupón
app.post('/createcupones', (req, res) => {
    const { Descripcion, Codigo, Fecha_Fin, Fecha_Inicio, Descuento, Activo, FechaCreacion, Estado, Motivo_Rechazo, ID_Usuario, ID_Tienda } = req.body; 

    if (!ID_Usuario) {
        return res.status(400).json({ error: "ID de usuario es requerido" });
    }

    const queryVerificarUsuario = 'SELECT * FROM usuario WHERE ID_Usuario = ?';
    connection.query(queryVerificarUsuario, [ID_Usuario], (err, results) => {
        if (err) {
            console.error("Error al verificar usuario: ", err.message);
            return res.status(500).json({ error: "Error al verificar usuario" });
        }

        if (results.length === 0) {
            return res.status(400).json({ error: "ID de usuario no válido" });
        }

        const query = 'INSERT INTO cupones (Descripcion, Codigo, Fecha_Fin, Fecha_Inicio, Descuento, Activo, FechaCreacion, Estado, Motivo_Rechazo, ID_Usuario, ID_Tienda) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        

        connection.query(query, [Descripcion, Codigo, Fecha_Fin, Fecha_Inicio, Descuento, Activo, FechaCreacion, Estado, Motivo_Rechazo, ID_Usuario, ID_Tienda], (err, results) => {
            if (err) {
                console.error("Error al registrar cupón: ", err.message);
                return res.status(500).json({ error: "Error al registrar cupón" });
            }
            res.status(201).json({ message: "Cupón registrado con éxito" });
        });
    });
});



// GET - Obtener todos los cupones de un vendedor
app.get('/cupones/vendedor/:id', (req, res) => {
    const { id } = req.params;
    const query = 'SELECT * FROM cupones WHERE ID_Usuario = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al obtener Cupones: ", err);
            res.status(500).json({ error: "Error al obtener cupones" });
            return;
        }
        res.status(200).json(results);
    });
});

// PUT - Actualizar un cupon existente
app.put('/cupones/:id', (req, res) => {
    const { id } = req.params;
    const { Descripcion, Codigo, Fecha_Fin, Descuento, Activo, Fecha_Inicio, Motivo_Rechazo } = req.body;

    
    const Estado = 0; 
    const query = 'UPDATE cupones SET Descripcion = ?, Codigo = ?, Fecha_Fin = ?, Descuento = ?, Activo = ?, Fecha_Inicio = ?, Estado = ?, Motivo_Rechazo = ? WHERE ID_Cupones = ?';

    connection.query(query, [Descripcion, Codigo, Fecha_Fin, Descuento, Activo, Fecha_Inicio, Estado, Motivo_Rechazo, id], (err, results) => {
        if (err) {
            console.error("Error al actualizar cupones: ", err);
            res.status(500).json({ error: "Error al actualizar cupón" });
            return;
        } else if (results.affectedRows === 0) {
            res.status(404).json({ error: "Cupón no encontrado" });
            return;
        }
        res.status(200).json({ message: "Cupón actualizado con éxito" });
    });
});


// DELETE - Eliminar un cupon existente
app.delete('/cupones/:id', (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM cupones WHERE ID_Cupones = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al eliminar cupón: ", err);
            res.status(500).json({ error: "Error al eliminar cupón" });
            return;
        } else if (results.affectedRows === 0) {
            res.status(404).json({ error: "Cupón no encontrado" });
            return;
        }
        res.status(200).json({ message: "Cupón eliminado con éxito" });
    });
});

const activarCupones = () => {
    const query = 'UPDATE cupones SET Activo = 1, Estado = 1 WHERE Fecha_Inicio <= NOW() AND Activo = 0';

    connection.query(query, async (err, results) => {
        if (err) {
            console.error("Error al activar cupones: ", err);
        } else {
            console.log(`${results.affectedRows} cupones activados con éxito`);

            try {
                const activatedCoupons = await promiseQuery(
                    'SELECT * FROM cupones WHERE Activo = 1 AND Estado = 1 AND Fecha_Inicio <= NOW()'
                );

                for (const cupon of activatedCoupons) {
                    const notificationData = {
                        title: '¡Nuevo Cupón Disponible! 🎉',
                        message: `¡El cupón ${cupon.Codigo} está activo! Descuento: ${cupon.Descuento}% 💫`,
                        url: '/cupones',
                        data: {
                            cuponId: cupon.ID_Cupones,
                            codigo: cupon.Codigo,
                            descuento: cupon.Descuento
                        }
                    };

                    for (const [_, subscription] of pushSubscriptions) {
                        try {
                            await sendPushNotification(subscription, notificationData);
                            console.log(`Notificación de cupón enviada a: ${subscription.endpoint}`);
                        } catch (notifError) {
                            console.error('Error al enviar notificación:', notifError);
                        }
                    }
                }
            } catch (error) {
                console.error("Error al procesar notificaciones de cupones:", error);
            }
        }
    });
};

setInterval(() => {
    activarCupones();
    desactivarCupones();
}, 10 * 60 * 1000); 

// PUT - Desactivar cupones que han pasado su fecha de fin
const desactivarCupones = () => {
    const query = 'UPDATE cupones SET Activo = 0 WHERE Fecha_Fin < NOW() AND Activo = 1';

    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al desactivar cupones: ", err);
        } else {
            console.log(`${results.affectedRows} cupones desactivados con éxito`);
        }
    });
};

setInterval(() => {
    activarCupones();
    desactivarCupones(); 
}, 10 * 60 * 1000); 


//VISTA ADMIN

// GET - Obtener todos los cupones
app.get('/cupones', (req, res) => {
    const query = 'SELECT * FROM cupones';

    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener Cupones: ", err);
            res.status(500).json({ error: "Error al obtener cupones" });
            return;
        }
        res.status(200).json(results);
    });
});

// PUT - Aprobar cupones
app.put('/cupones/aprobar/:id', (req, res) => {
    const { id } = req.params;
    const currentDateTime = new Date().toISOString(); 

    const query = `
        UPDATE cupones 
        SET Estado = 1, Fecha_Aprobacion = ? 
        WHERE ID_Cupones = ?`; 

    connection.query(query, [currentDateTime, id], (err, results) => {
        if (err) {
            console.error("Error al aprobar el cupón: ", err);
            res.status(500).json({ error: "Error al aprobar el cupón" });
            return;
        } else if (results.affectedRows === 0) {
            res.status(404).json({ error: "Cupón no encontrado" });
            return;
        }
        res.status(200).json({ message: "Cupón aprobado con éxito" });
    });
});


// PUT - Rechazar cupones
app.put('/cupones/rechazar/:id', (req, res) => {
    const { id } = req.params;
    const { Motivo_Rechazo } = req.body;
    const query = 'UPDATE cupones SET Estado = 2, Motivo_Rechazo = ? WHERE ID_Cupones = ?'; 

    connection.query(query, [Motivo_Rechazo, id], (err, results) => {
        if (err) {
            console.error("Error al rechazar el cupón: ", err);
            res.status(500).json({ error: "Error al rechazar el cupón" });
            return;
        } else if (results.affectedRows === 0) {
            res.status(404).json({ error: "Cupón no encontrado" });
            return;
        }
        res.status(200).json({ message: "Cupón rechazado con éxito" });
    });
});

//GET - Obtener todos los cupones pendientes
app.get('/cupones/pendientes', (req, res) => {
    console.log("Solicitud recibida para cupones pendientes");
    const query = 'SELECT * FROM cupones WHERE Estado = 0';
    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener cupones: ", err);
            return res.status(500).json({ error: "Error al obtener cupones" });
        }
        console.log("Resultados obtenidos: ", results);
        res.status(200).json(results);
    });
});


// GET - Obtener todos los cupones aprobados
app.get('/cupones/aprobados', (req, res) => {
    const query = 'SELECT * FROM cupones WHERE Estado = 1';

    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener cupones aprobados: ", err);
            res.status(500).json({ error: "Error al obtener cupones aprobados" });
            return;
        }
        res.status(200).json(results);
    });
});

//#endregion

//#region CRUD Tienda

const uploadDir = './uploads/';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}


const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir); 
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); 
    }
});

const upload = multer({ storage: storage });

// POST - Registrar una nueva tienda
app.post('/createtienda', upload.single('logo'), (req, res) => {
    const { NombreTienda, Descripcion, userId } = req.body;
    const logo = req.file ? req.file.originalname : null;
    if (!NombreTienda || !logo || userId ==0) {
        return res.status(400).json({ error: "Nombre de la tienda y logo son requeridos." });
    }

    const query = 'INSERT INTO tienda (NombreTienda, Descripcion, logo, creacion, ID_Usuario) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)';
    connection.query(query, [NombreTienda, Descripcion, logo, userId], (err, results) => {
        if (err) {
            console.error("Error al registrar tienda: ", err);
            return res.status(500).json({ error: "Error al registrar tienda" });
        }
        res.status(201).json({ message: "Tienda registrada con éxito" });
    });
});

// GET - Obtener todas las tiendas
app.get('/tienda/:id', (req, res) => {
    const { id } = req.params;
    const query = 'SELECT * FROM tienda WHERE ID_Usuario = ?';
    
    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al obtener tiendas: ", err);
            return res.status(500).json({ error: "Error al obtener tiendas" });
        }
        console.log('err', results);
        
        res.status(200).json(results);
    });
});

// GET - Obtener una tienda por ID
app.get('/tienda/:id', (req, res) => {
    const { id } = req.params;
    const query = 'SELECT * FROM tienda WHERE ID_Tienda = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al obtener tienda: ", err);
            return res.status(500).json({ error: "Error al obtener tienda" });
        } 
        if (results.length === 0) {
            return res.status(404).json({ error: "Tienda no encontrada" });
        }
        res.status(200).json(results[0]);
    });
});



// PUT - Actualizar una tienda existente
app.put('/tienda/:id', upload.single('logo'), (req, res) => {
    const { id } = req.params;
    const { NombreTienda, Descripcion } = req.body;

    connection.query('SELECT logo FROM tienda WHERE ID_Tienda = ?', [id], (err, results) => {
        if (err) {
            console.error("Error al obtener tienda: ", err);
            return res.status(500).json({ error: "Error al obtener tienda" });
        }
        if (results.length === 0) {
            return res.status(404).json({ error: "Tienda no encontrada" });
        }

        const currentLogo = results[0].logo;
        const logo = req.file ? req.file.originalname : currentLogo; 

        const query = 'UPDATE tienda SET NombreTienda = ?, Descripcion = ?, logo = ? WHERE ID_Tienda = ?';
        connection.query(query, [NombreTienda, Descripcion, logo, id], (err, results) => {
            if (err) {
                console.error("Error al actualizar tienda: ", err);
                return res.status(500).json({ error: "Error al actualizar tienda" });
            }
            if (results.affectedRows === 0) {
                return res.status(404).json({ error: "Tienda no encontrada" });
            }
            res.status(200).json({ message: "Tienda actualizada con éxito" });
        });
    });
});


// DELETE - Eliminar una tienda existente
app.delete('/tienda/:id', (req, res) => {
    const { id } = req.params;
    const query = 'DELETE FROM tienda WHERE ID_Tienda = ?';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al eliminar tienda: ", err);
            return res.status(500).json({ error: "Error al eliminar tienda" });
        }
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Tienda no encontrada" });
        }
        res.status(200).json({ message: "Tienda eliminada con éxito" });
    });
});


// PARA LA VISTA ADMIN
// GET - Obtener todas las tiendas
app.get('/tienda/', (req, res) => { 
    const query = 'SELECT * FROM tienda';
    
    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener tiendas: ", err);
            return res.status(500).json({ error: "Error al obtener tiendas" });
        }
        console.log('err', results);
        
        res.status(200).json(results);
    });
});

// GET - Obtener todas las tiendas pendientes
app.get('/tiendas/pendientes', (req, res) => {
    const query = 'SELECT * FROM tienda WHERE activo = 0';
    connection.query(query, (err, results) => {
        if (err) {
            console.error("Error al obtener tiendas pendientes: ", err);
            return res.status(500).json({ error: "Error al obtener tiendas pendientes" });
        }
        res.status(200).json(results);
    });
});

// PUT - Aprobar una tienda
app.put('/tienda/aprobar/:id', (req, res) => {
    const { id } = req.params;

    const query = 'UPDATE tienda SET activo = 1 WHERE ID_Tienda = ?';
    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al aprobar tienda: ", err);
            return res.status(500).json({ error: "Error al aprobar tienda" });
        }
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Tienda no encontrada" });
        }
        res.status(200).json({ message: "Tienda aprobada con éxito" });
    });
});

// PUT - Rechazar una tienda
app.put('/tienda/rechazar/:id', (req, res) => {
    const { id } = req.params;

    const query = 'UPDATE tienda SET activo = 2 WHERE ID_Tienda = ?';
    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al rechazar tienda: ", err);
            return res.status(500).json({ error: "Error al rechazar tienda" });
        }
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Tienda no encontrada" });
        }
        res.status(200).json({ message: "Tienda rechazada con éxito" });
    });
});

// PUT - Activar de nuevo una tienda
app.put('/tienda/activar/:id', (req, res) => {
    const { id } = req.params;
    const query = 'UPDATE tienda SET activo = 1 WHERE ID_Tienda = ? AND activo = 3';

    connection.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error al activar tienda: ", err);
            return res.status(500).json({ error: "Error al activar tienda" });
        }
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Tienda no encontrada o ya activa" });
        }
        res.status(200).json({ message: "Tienda activada con éxito" });
    });
});

// PUT - Dar de baja una tienda
app.put('/tienda/baja/:id', (req, res) => {
    const { id } = req.params;
    const { motivo_baja } = req.body;

    const query = 'UPDATE tienda SET activo = 3, motivo_baja = ? WHERE ID_Tienda = ?';
    connection.query(query, [motivo_baja, id], (err, results) => {
        if (err) {
            console.error("Error al dar de baja tienda: ", err);
            return res.status(500).json({ error: "Error al dar de baja tienda" });
        }
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: "Tienda no encontrada" });
        }
        res.status(200).json({ message: "Tienda dada de baja con éxito" });
    });
});

//#endregion

//#region CRUD Carrito

// GET -Obtener productos sin oferta en el carrito de un usuario
app.get('/carrito-sin-oferta/:userId', (req, res) => {
    const userId = req.params.userId;

    if (!userId) {
        return res.status(400).json({ error: 'ID de usuario no proporcionado' });
    }

    const query = `
        SELECT 
            p.ID_Producto, 
            p.Nombre_Producto, 
            p.Precio, 
            p.Imagen, 
            cp.Cantidad,
            o.Activo AS OfertaActiva,
            t.NombreTienda,
            t.ID_Tienda
        FROM 
            carrito c
        JOIN 
            carrito_producto cp ON c.ID_Carrito = cp.ID_Carrito
        JOIN 
            producto p ON cp.ID_Producto = p.ID_Producto
        LEFT JOIN 
            ofertas o ON p.ID_Producto = o.ID_Producto AND o.Activo = 1
        JOIN 
            tienda t ON p.ID_Tienda = t.ID_Tienda
        WHERE 
            c.ID_Usuario = ? AND 
            o.ID_Oferta IS NULL;
    `;

    connection.query(query, [userId], (err, results) => {
        if (err) {
            console.error("Error al obtener los productos sin oferta: ", err);
            return res.status(500).json({ error: 'Error al obtener los productos sin oferta' });
        }
        
        res.status(200).json(results);
    });
});

// Obtener carrito de un usuario
app.get('/carrito/:userId', (req, res) => {
    const userId = req.params.userId;

    const query = `
        SELECT 
            cp.*, 
            p.Nombre_Producto, 
            p.Imagen, 
            p.ID_Tienda, 
            IFNULL(t.NombreTienda, 'Tienda no disponible') AS NombreTienda 
        FROM 
            carrito_producto cp
        JOIN 
            carrito c ON cp.ID_Carrito = c.ID_Carrito
        JOIN 
            producto p ON cp.ID_Producto = p.ID_Producto
        LEFT JOIN 
            tienda t ON p.ID_Tienda = t.ID_Tienda
        WHERE 
            c.ID_Usuario = ?;
    `;

    connection.query(query, [userId], (err, results) => {
        if (err) {
            console.error("Error al obtener el carrito: ", err);
            return res.status(500).json({ error: 'Error al obtener el carrito' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'Carrito no encontrado' });
        }

        res.status(200).json(results);
    });
});


// Agregar producto al carrito
app.post('/carrito', async (req, res) => {
    const { ID_Usuario, ID_Producto, Cantidad } = req.body;

    if (!ID_Usuario || !ID_Producto || !Cantidad) {
        return res.status(400).json({ error: "Faltan datos requeridos." });
    }

    try {
     
        const cartIdQuery = 'SELECT ID_Carrito FROM carrito WHERE ID_Usuario = ?';
        const cartResults = await new Promise((resolve, reject) => {
            connection.query(cartIdQuery, [ID_Usuario], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        let ID_Carrito;
        if (cartResults.length === 0) {
        
            const insertCartQuery = 'INSERT INTO carrito (ID_Usuario) VALUES (?)';
            const result = await new Promise((resolve, reject) => {
                connection.query(insertCartQuery, [ID_Usuario], (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });
            ID_Carrito = result.insertId;
        } else {
            ID_Carrito = cartResults[0].ID_Carrito;
        }

        const priceQuery = 'SELECT Precio FROM producto WHERE ID_Producto = ?';
        const priceResult = await new Promise((resolve, reject) => {
            connection.query(priceQuery, [ID_Producto], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (priceResult.length === 0) {
            return res.status(404).json({ error: "Producto no encontrado." });
        }

        const Precio = priceResult[0].Precio;

        const checkProductQuery = 'SELECT * FROM carrito_producto WHERE ID_Carrito = ? AND ID_Producto = ?';
        const productResults = await new Promise((resolve, reject) => {
            connection.query(checkProductQuery, [ID_Carrito, ID_Producto], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (productResults.length > 0) {
            const newQuantity = productResults[0].Cantidad + Cantidad;
            const updateQuantityQuery = 'UPDATE carrito_producto SET Cantidad = ?, Precio = ? WHERE ID_Carrito = ? AND ID_Producto = ?';
            await new Promise((resolve, reject) => {
                connection.query(updateQuantityQuery, [newQuantity, Precio, ID_Carrito, ID_Producto], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        } else {
            const insertProductQuery = 'INSERT INTO carrito_producto (ID_Carrito, ID_Producto, Cantidad, Precio) VALUES (?, ?, ?, ?)';
            await new Promise((resolve, reject) => {
                connection.query(insertProductQuery, [ID_Carrito, ID_Producto, Cantidad, Precio], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        }

        res.status(200).json({ message: "Producto agregado al carrito." });
    } catch (error) {
        console.error("Error al agregar producto al carrito: ", error);
        res.status(500).json({ error: "Error al agregar producto al carrito." });
    }
});

// PUT - Actualizar productos sin oferta en el carrito
app.put('/carrito-sin-oferta/:userId', async (req, res) => {
    const userId = req.params.userId;
    const items = req.body.items; 

    try {
        const cartIdQuery = 'SELECT ID_Carrito FROM carrito WHERE ID_Usuario = ?';
        const cartResults = await new Promise((resolve, reject) => {
            connection.query(cartIdQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (cartResults.length === 0) {
            return res.status(404).json({ error: "Carrito no encontrado" });
        }

        const ID_Carrito = cartResults[0].ID_Carrito;

        for (const item of items) {
            const query = `
                INSERT INTO carrito_producto (ID_Carrito, ID_Producto, Cantidad, Precio) 
                VALUES (?, ?, ?, ?) 
                ON DUPLICATE KEY UPDATE Cantidad = ?`;
            await new Promise((resolve, reject) => {
                connection.query(query, [ID_Carrito, item.ID_Producto, item.Cantidad, item.Precio, item.Cantidad], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        }

        res.status(200).json({ message: "Productos sin oferta actualizados." });
    } catch (error) {
        console.error("Error al actualizar productos sin oferta: ", error);
        res.status(500).json({ error: "Error al actualizar productos sin oferta." });
    }
});


// PUT - Actualizar productos en el carrito
app.put('/carrito/:userId', async (req, res) => {
    const userId = req.params.userId;
    const items = req.body.items; 

    try {
        const cartIdQuery = 'SELECT ID_Carrito FROM carrito WHERE ID_Usuario = ?';
        const cartResults = await new Promise((resolve, reject) => {
            connection.query(cartIdQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (cartResults.length === 0) {
            return res.status(404).json({ error: "Carrito no encontrado" });
        }

        const ID_Carrito = cartResults[0].ID_Carrito;

        for (const item of items) {
            const query = `
                INSERT INTO carrito_producto (ID_Carrito, ID_Producto, Cantidad, Precio) 
                VALUES (?, ?, ?, ?) 
                ON DUPLICATE KEY UPDATE Cantidad = ?`;
            await new Promise((resolve, reject) => {
                connection.query(query, [ID_Carrito, item.ID_Producto, item.Cantidad, item.Precio, item.Cantidad], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        }

        res.status(200).json({ message: "Carrito actualizado." });
    } catch (error) {
        console.error("Error al actualizar el carrito: ", error);
        res.status(500).json({ error: "Error al actualizar el carrito." });
    }
});

// DELETE - Eliminar producto del carrito
app.delete('/carrito', async (req, res) => {
    const { ID_Usuario, ID_Producto } = req.body;

    if (!ID_Usuario || !ID_Producto) {
        return res.status(400).json({ error: "Faltan datos requeridos." });
    }

    try {
        // Obtener el ID_Carrito del usuario
        const cartIdQuery = 'SELECT ID_Carrito FROM carrito WHERE ID_Usuario = ?';
        const cartResults = await new Promise((resolve, reject) => {
            connection.query(cartIdQuery, [ID_Usuario], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (cartResults.length === 0) {
            return res.status(404).json({ error: "Carrito no encontrado." });
        }

        const ID_Carrito = cartResults[0].ID_Carrito;

        // Eliminar el producto del carrito
        const deleteQuery = 'DELETE FROM carrito_producto WHERE ID_Carrito = ? AND ID_Producto = ?';
        await new Promise((resolve, reject) => {
            connection.query(deleteQuery, [ID_Carrito, ID_Producto], (err, results) => {
                if (err) return reject(err);
                if (results.affectedRows === 0) {
                    return res.status(404).json({ error: "Producto no encontrado en el carrito." });
                }
                resolve();
            });
        });

        res.status(200).json({ message: "Producto eliminado del carrito." });
    } catch (error) {
        console.error("Error al eliminar producto del carrito: ", error);
        res.status(500).json({ error: "Error al eliminar producto del carrito." });
    }
});

// DELETE - Limpiar carrito completo
app.delete('/carrito/clear/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        // Obtener el ID_Carrito del usuario
        const cartIdQuery = 'SELECT ID_Carrito FROM carrito WHERE ID_Usuario = ?';
        const cartResults = await new Promise((resolve, reject) => {
            connection.query(cartIdQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (cartResults.length > 0) {
            const ID_Carrito = cartResults[0].ID_Carrito;

            // Eliminar todos los productos del carrito
            const deleteProductsQuery = 'DELETE FROM carrito_producto WHERE ID_Carrito = ?';
            await new Promise((resolve, reject) => {
                connection.query(deleteProductsQuery, [ID_Carrito], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            // Eliminar el carrito
            const deleteCartQuery = 'DELETE FROM carrito WHERE ID_Usuario = ?';
            await new Promise((resolve, reject) => {
                connection.query(deleteCartQuery, [userId], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        }

        res.status(200).json({ message: "Carrito limpiado exitosamente." });
    } catch (error) {
        console.error("Error al limpiar el carrito: ", error);
        res.status(500).json({ error: "Error al limpiar el carrito." });
    }
});

// POST - Registro con carrito
app.post ('/carrito/registro', async (req, res) => {
    const { ID_Usuario } =req.body;
    const query = 'INSERT INTO carrito (ID_Usuario) VALUES (?)';
    connection.query(query, [ID_Usuario], (err, results) => {
        if (err) {
            console.error("Error al registrar el carrito: ", err);
            return res.status(500).json({ error: "Error al registrar el carrito" });
        }
        res.status(201).json({ message: "Carrito registrado con éxito" });
    });
});
//#endregion

//#region CRUD CHECKOUT
// Endpoint para validar el cupón y calcular el descuento
app.get('/api/coupons/:code', async (req, res) => {
    const couponCode = req.params.code;
    const { subtotal, userId } = req.query;

    try {
        const checkUsageQuery = `
            SELECT 
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM cupones_usados 
                        WHERE ID_Cupon = c.ID_Cupones 
                        AND ID_Usuario = ?
                    ) THEN 'used'
                    WHEN EXISTS (
                        SELECT 1 FROM cupones_en_uso 
                        WHERE ID_Cupon = c.ID_Cupones 
                        AND ID_Usuario = ?
                    ) THEN 'in_use'
                    ELSE 'available'
                END as status,
                c.*
            FROM cupones c
            WHERE c.Codigo = ? AND c.Activo = 1 AND c.Estado = 1
        `;

        const [usageResult] = await queryDatabase(checkUsageQuery, [userId, userId, couponCode]);
        
        if (!usageResult) {
            return res.status(404).json({ error: 'Cupón no encontrado o inactivo' });
        }

        if (usageResult.status === 'used') {
            return res.status(400).json({ error: 'Ya has usado este cupón anteriormente.' });
        }

        const currentDate = new Date();
        const startDate = new Date(usageResult.Fecha_Inicio);
        const endDate = new Date(usageResult.Fecha_Fin);

        if (currentDate < startDate || currentDate > endDate) {
            return res.status(400).json({ error: 'El cupón no está vigente.' });
        }

        if (usageResult.status === 'available') {
            await queryDatabase(
                'INSERT INTO cupones_en_uso (ID_Cupon, ID_Usuario, Codigo_Cupon) VALUES (?, ?, ?)',
                [usageResult.ID_Cupones, userId, couponCode]
            );
        }

        const calculatedDiscount = (parseFloat(subtotal) * (usageResult.Descuento / 100)).toFixed(2);

        return res.json({
            id: usageResult.ID_Cupones,
            code: usageResult.Codigo,
            discount: usageResult.Descuento,
            calculatedDiscount: calculatedDiscount,
            start_date: usageResult.Fecha_Inicio,
            end_date: usageResult.Fecha_Fin,
            storeId: usageResult.ID_Tienda
        });

    } catch (error) {
        console.error("Error al validar cupón:", error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// endpoint de crear orden
app.post('/api/create-order', async (req, res) => {
    const { 
        total, 
        subtotal,
        couponCode,
        products, 
        paymentMethod, 
        ID_Usuario, 
        Monto_Descuento, 
        Monto_Oferta
    } = req.body;

    const round = (num) => Math.round((num + Number.EPSILON) * 100) / 100;

    try {
        await new Promise((resolve, reject) => {
            connection.beginTransaction(err => {
                if (err) reject(err);
                else resolve();
            });
        });

        const numericSubtotal = round(parseFloat(subtotal));
        const numericMontoOferta = round(parseFloat(Monto_Oferta || 0));
        const numericMontoDescuento = round(parseFloat(Monto_Descuento || 0));
        const numericTotal = round(parseFloat(total));

        let couponId = null;
        let finalMontoDescuento = numericMontoDescuento;

        if (couponCode) {
            const query = `
                SELECT c.ID_Cupones, c.Codigo, c.Descuento, c.Fecha_Inicio, c.Fecha_Fin, 
                       c.ID_Tienda, c.Activo, c.Estado
                FROM cupones c
                WHERE c.Codigo = ? AND c.Activo = 1 AND c.Estado = 1
            `;

            const [results] = await promiseQuery(query, [couponCode]);
            
            if (results && results.length > 0) {
                const coupon = results[0];
                const currentDate = new Date();
                const startDate = new Date(coupon.Fecha_Inicio);
                const endDate = new Date(coupon.Fecha_Fin);

                if (currentDate < startDate || currentDate > endDate) {
                    await connection.rollback();
                    return res.status(400).json({ message: 'El cupón no está vigente.' });
                }

                couponId = coupon.ID_Cupones;
            }
        }

        const calculatedTotal = round(numericSubtotal - numericMontoOferta - finalMontoDescuento);

        if (Math.abs(calculatedTotal - numericTotal) > 0.01) {
            await connection.rollback();
            return res.status(400).json({ 
                message: 'El total no coincide con los descuentos aplicados',
                debug: {
                    subtotal: numericSubtotal,
                    montoOferta: numericMontoOferta,
                    montoDescuento: finalMontoDescuento,
                    totalRecibido: numericTotal,
                    totalCalculado: calculatedTotal
                }
            });
        }

        const orderQuery = `
            INSERT INTO pedidos (
                ID_Usuario, 
                Fecha_Pedido, 
                Estado_Pedido, 
                Total, 
                Subtotal,
                Metodo_Pago, 
                Monto_Descuento, 
                Monto_Oferta
            ) 
            VALUES (?, NOW(), 'Completado', ?, ?, ?, ?, ?)
        `;

        const orderValues = [
            ID_Usuario, 
            calculatedTotal,
            numericSubtotal,
            paymentMethod, 
            finalMontoDescuento,
            numericMontoOferta
        ];

        const orderResult = await promiseQuery(orderQuery, orderValues);
        const orderId = orderResult.insertId;

        for (const product of products) {
            await promiseQuery(
                `INSERT INTO pedido_producto 
                (ID_Pedido, ID_Producto, Cantidad, Precio_Unitario) 
                VALUES (?, ?, ?, ?)`,
                [orderId, product.ID_Producto, product.Cantidad, 
                round(parseFloat(product.Precio_Unitario))]
            );
        }

        await connection.commit();

        return res.status(201).json({ 
            success: true,
            message: 'Pedido creado con éxito',
            orderId: orderId 
        });

    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        console.error('Error al crear el pedido:', error);
        return res.status(500).json({ message: 'Error al crear el pedido' });
    }
});

// Endpoint para mover el cupón a usado
app.post('/api/coupons/move-to-used', async (req, res) => {
    const { couponCode, userId, orderId } = req.body;

    console.log('Recibida solicitud para mover cupón:', {
        couponCode,
        userId,
        orderId
    });

    try {
        await connection.beginTransaction();

        const [result] = await promiseQuery(
            'SELECT * FROM cupones_en_uso WHERE Codigo_Cupon = ? AND ID_Usuario = ?',
            [couponCode, userId]
        );

        console.log('Resultado búsqueda en cupones_en_uso:', result);

        if (!result || result.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: 'Cupón no encontrado en cupones_en_uso'
            });
        }

        const cuponEnUso = result;
        console.log('Cupón encontrado:', cuponEnUso);

        const [cuponesUsados] = await promiseQuery(
            'SELECT 1 FROM cupones_usados WHERE ID_Cupon = ? AND ID_Usuario = ?',
            [cuponEnUso.ID_Cupon, userId]
        );

        console.log('Resultado verificación cupones_usados:', cuponesUsados);

        if (cuponesUsados && cuponesUsados.length > 0) {
            await promiseQuery(
                'DELETE FROM cupones_en_uso WHERE ID_CuponEnUso = ?',
                [cuponEnUso.ID_CuponEnUso]
            );
            
            console.log('Cupón ya existía en usados, eliminado de en_uso');
        } else {
            try {
                console.log('Intentando insertar en cupones_usados:', {
                    ID_Cupon: cuponEnUso.ID_Cupon,
                    ID_Usuario: userId,
                    ID_Pedido: orderId
                });

                await promiseQuery(
                    'INSERT INTO cupones_usados (ID_Cupon, ID_Usuario, ID_Pedido) VALUES (?, ?, ?)',
                    [cuponEnUso.ID_Cupon, userId, orderId]
                );

                console.log('Eliminando de cupones_en_uso, ID:', cuponEnUso.ID_CuponEnUso);
                await promiseQuery(
                    'DELETE FROM cupones_en_uso WHERE ID_CuponEnUso = ?',
                    [cuponEnUso.ID_CuponEnUso]
                );

                console.log('Operaciones de base de datos completadas exitosamente');
            } catch (dbError) {
                console.error('Error en operaciones de DB:', dbError);
                throw dbError;
            }
        }

        await connection.commit();
        console.log('Transacción completada exitosamente');

        res.json({
            success: true,
            message: 'Cupón movido exitosamente',
            details: {
                cuponId: cuponEnUso.ID_Cupon,
                userId: userId,
                orderId: orderId
            }
        });

    } catch (error) {
        console.error('Error detallado al mover cupón:', error);
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Error en rollback:', rollbackError);
            }
        }
        res.status(500).json({
            success: false,
            message: 'Error al mover cupón',
            error: error.message
        });
    }
});

// Endpoint para mover el cupón
app.post('/api/coupons/move-to-used', async (req, res) => {
    const { couponCode, userId, orderId } = req.body;

    console.log('Recibida solicitud para mover cupón:', {
        couponCode,
        userId,
        orderId
    });

    if (!couponCode || !userId || !orderId) {
        console.error('Faltan datos requeridos:', { couponCode, userId, orderId });
        return res.status(400).json({
            success: false,
            message: 'Faltan datos requeridos'
        });
    }

    let connection;
    try {
        connection = await mysql.createConnection({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'zapateria2'
        });

        await connection.beginTransaction();

        const [cuponesEnUso] = await connection.query(
            'SELECT * FROM cupones_en_uso WHERE Codigo_Cupon = ? AND ID_Usuario = ?',
            [couponCode, userId]
        );

        console.log('Resultado búsqueda en cupones_en_uso:', cuponesEnUso);

        if (!cuponesEnUso || cuponesEnUso.length === 0) {
            throw new Error('Cupón no encontrado en cupones_en_uso');
        }

        const cuponEnUso = cuponesEnUso[0];

        const [cuponesUsados] = await connection.query(
            'SELECT * FROM cupones_usados WHERE ID_Cupon = ? AND ID_Usuario = ?',
            [cuponEnUso.ID_Cupon, userId]
        );

        console.log('Verificación en cupones_usados:', cuponesUsados);

        if (cuponesUsados && cuponesUsados.length > 0) {
            console.log('Cupón ya está en cupones_usados, solo limpiando cupones_en_uso');
            await connection.query(
                'DELETE FROM cupones_en_uso WHERE ID_CuponEnUso = ?',
                [cuponEnUso.ID_CuponEnUso]
            );
        } else {
            console.log('Insertando en cupones_usados:', {
                ID_Cupon: cuponEnUso.ID_Cupon,
                ID_Usuario: userId,
                ID_Pedido: orderId
            });

            await connection.query(
                'INSERT INTO cupones_usados (ID_Cupon, ID_Usuario, ID_Pedido) VALUES (?, ?, ?)',
                [cuponEnUso.ID_Cupon, userId, orderId]
            );

            console.log('Eliminando de cupones_en_uso');
            await connection.query(
                'DELETE FROM cupones_en_uso WHERE ID_CuponEnUso = ?',
                [cuponEnUso.ID_CuponEnUso]
            );
        }

        await connection.commit();
        console.log('Transacción completada exitosamente');

        res.json({
            success: true,
            message: 'Cupón movido exitosamente'
        });

    } catch (error) {
        console.error('Error detallado al mover cupón:', error);
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Error en rollback:', rollbackError);
            }
        }
        res.status(500).json({
            success: false,
            message: 'Error al mover cupón',
            error: error.message,
            details: error.stack
        });
    } finally {
        if (connection) {
            try {
                await connection.end();
            } catch (endError) {
                console.error('Error al cerrar conexión:', endError);
            }
        }
    }
});

// GET - Obtener detalles del pedido
app.get('/api/order/:orderId', async (req, res) => {
    const { orderId } = req.params;

    try {
        const order = await getOrderById(orderId);
        if (!order) {
            return res.status(404).json({ message: 'Pedido no encontrado' });
        }
        res.json(order);
    } catch (error) {
        console.error('Error al obtener el pedido:', error);
        res.status(500).json({ message: 'Error en el servidor' });
    }
});

async function getOrderById(orderId) {
    const orderRows = await queryDatabase('SELECT * FROM pedidos WHERE ID_Pedido = ?', [orderId]);
    if (orderRows.length === 0) return null;

    const order = orderRows[0];
    
    const productRows = await queryDatabase(`
        SELECT p.Nombre_Producto, pp.Cantidad, pp.Precio_Unitario, t.NombreTienda
        FROM pedido_producto pp
        JOIN producto p ON pp.ID_Producto = p.ID_Producto
        JOIN tienda t ON p.ID_Tienda = t.ID_Tienda
        WHERE pp.ID_Pedido = ?`, [orderId]);

    const couponDiscount = order.ID_Cupon ? await getCouponDiscount(order.ID_Cupon) : 0;
    const offerDiscount = order.ID_Ofertas ? await getOfferDiscount(order.ID_Ofertas) : 0;

    return {
        id: order.ID_Pedido,
        total: order.Total,
        precio: order.Subtotal, 
        estado: order.Estado_Pedido,
        metodo_pago: order.Metodo_Pago,
        direccion_envio: order.Direccion_Envio,
        notas: order.Notas,
        monto_descuento: order.Monto_Descuento || 0,
        monto_oferta: order.Monto_Oferta || 0,
        couponDiscount,
        offerDiscount,
        fecha_pedido: order.Fecha_Pedido, 
        products: productRows.map(product => ({
            Nombre_Producto: product.Nombre_Producto,
            Cantidad: product.Cantidad,
            Precio_Unitario: product.Precio_Unitario,
            NombreTienda: product.NombreTienda,
        })),
    };
}

//#endregion

//#region ENDPOINTS PARA EL DASHBOARD

// Endpoints para el Dashboard de Administrador
app.get('/api/admin/stats', async (req, res) => {
    try {
        const userCountQuery = 'SELECT COUNT(DISTINCT ID_Usuario) as total FROM carrito';
        const usersResult = await queryDatabase(userCountQuery);

        const storeCountQuery = 'SELECT COUNT(*) as total FROM tienda WHERE activo = 1';
        const storesResult = await queryDatabase(storeCountQuery);

        const productCountQuery = 'SELECT COUNT(*) as total FROM producto';
        const productsResult = await queryDatabase(productCountQuery);
        
        const orderCountQuery = 'SELECT COUNT(*) as total FROM pedidos';
        const ordersResult = await queryDatabase(orderCountQuery);
        
        const salesQuery = `
            SELECT SUM(Total) as total 
            FROM pedidos 
            WHERE Estado_Pedido = 'Completado'
        `;
        const salesResult = await queryDatabase(salesQuery);

        const pendingStoresQuery = 'SELECT COUNT(*) as total FROM tienda WHERE activo = 0';
        const pendingStoresResult = await queryDatabase(pendingStoresQuery);

        const pendingCouponsQuery = 'SELECT COUNT(*) as total FROM cupones WHERE Estado = 0';
        const pendingCouponsResult = await queryDatabase(pendingCouponsQuery);

        res.json({
            totalUsers: usersResult[0].total,
            totalStores: storesResult[0].total,
            totalProducts: productsResult[0].total,
            totalOrders: ordersResult[0].total,
            totalSales: salesResult[0].total || 0,
            pendingStores: pendingStoresResult[0].total,
            pendingCoupons: pendingCouponsResult[0].total
        });
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

//registro de tiendas
app.get('/api/admin/stores-monthly', async (req, res) => {
    try {
        const query = `
            SELECT 
                DATE_FORMAT(creacion, '%Y-%m') as month,
                COUNT(*) as count
            FROM tienda
            WHERE creacion >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
            GROUP BY DATE_FORMAT(creacion, '%Y-%m')
            ORDER BY month DESC
        `;
        
        const results = await queryDatabase(query);
        res.json(results);
    } catch (error) {
        console.error('Error al obtener registro mensual de tiendas:', error);
        res.status(500).json({ error: 'Error al obtener registro de tiendas' });
    }
});

//registro mensual de usuarios
app.get('/api/admin/users-monthly', async (req, res) => {
    try {
        const query = `
            SELECT 
                DATE_FORMAT(c.fecha_creacion, '%Y-%m') as month,
                COUNT(DISTINCT c.ID_Usuario) as count
            FROM carrito c
            WHERE c.fecha_creacion >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
            GROUP BY DATE_FORMAT(c.fecha_creacion, '%Y-%m')
            ORDER BY month DESC
        `;
        
        const results = await queryDatabase(query);
        res.json(results);
    } catch (error) {
        console.error('Error al obtener registro mensual de usuarios:', error);
        res.status(500).json({ error: 'Error al obtener registro de usuarios' });
    }
});


// Distribución de usuarios por rol
app.get('/api/admin/user-role-distribution', async (req, res) => {
    try {
        const query = `
            SELECT 
                CASE 
                    WHEN ID_Rol = 1 THEN 'usuario'
                    WHEN ID_Rol = 2 THEN 'vendedor'
                END as role,
                COUNT(*) as count
            FROM usuario
            WHERE ID_Rol IN (1, 2)
            GROUP BY ID_Rol
        `;
        
        const results = await queryDatabase(query);
        res.json(results);
    } catch (error) {
        console.error('Error al obtener distribución de roles:', error);
        res.status(500).json({ error: 'Error al obtener distribución de roles' });
    }
});

// Nueva ruta para estadísticas de tiendas
app.get('/api/admin/store-stats', async (req, res) => {
    try {
        const query = `
            SELECT 
                DATE_FORMAT(creacion, '%Y-%m') as month,
                COUNT(*) as count,
                SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN activo = 0 THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN activo = 2 THEN 1 ELSE 0 END) as rejected
            FROM tienda
            GROUP BY DATE_FORMAT(creacion, '%Y-%m')
            ORDER BY month DESC
            LIMIT 6
        `;
        const results = await queryDatabase(query);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener estadísticas de tiendas' });
    }
});

// Nueva ruta para estadísticas de cupones y ofertas
app.get('/api/admin/promotions-stats', async (req, res) => {
    try {
        const [cupones, ofertas] = await Promise.all([
            queryDatabase(`
                SELECT 
                    DATE_FORMAT(FechaCreacion, '%Y-%m') as month,
                    COUNT(*) as total,
                    SUM(CASE WHEN Estado = 1 THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN Estado = 0 THEN 1 ELSE 0 END) as pending
                FROM cupones
                GROUP BY DATE_FORMAT(FechaCreacion, '%Y-%m')
                ORDER BY month DESC
                LIMIT 6
            `),
            queryDatabase(`
                SELECT 
                    DATE_FORMAT(Fecha_Creacion, '%Y-%m') as month,
                    COUNT(*) as total,
                    SUM(CASE WHEN Activo = 1 THEN 1 ELSE 0 END) as active
                FROM ofertas
                GROUP BY DATE_FORMAT(Fecha_Creacion, '%Y-%m')
                ORDER BY month DESC
                LIMIT 6
            `)
        ]);

        res.json({ cupones, ofertas });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener estadísticas de promociones' });
    }
});


// Cupones Usados y En Uso Global
app.get('/api/admin/coupons-usage', async (req, res) => {
    try {
        const [usedQuery, inUseQuery] = await Promise.all([
            queryDatabase(`
                SELECT 
                    c.Codigo,
                    c.Descuento,
                    t.NombreTienda,
                    COUNT(*) as total_uses,
                    DATE_FORMAT(cu.Fecha_Uso, '%Y-%m') as month
                FROM cupones_usados cu
                JOIN cupones c ON cu.ID_Cupon = c.ID_Cupones
                JOIN tienda t ON c.ID_Tienda = t.ID_Tienda
                GROUP BY c.ID_Cupones, DATE_FORMAT(cu.Fecha_Uso, '%Y-%m')
                ORDER BY month DESC
            `),
            queryDatabase(`
                SELECT 
                    c.Codigo,
                    c.Descuento,
                    t.NombreTienda,
                    COUNT(*) as active_uses,
                    DATE_FORMAT(ce.Fecha_Inicio, '%Y-%m') as month
                FROM cupones_en_uso ce
                JOIN cupones c ON ce.ID_Cupon = c.ID_Cupones
                JOIN tienda t ON c.ID_Tienda = t.ID_Tienda
                GROUP BY c.ID_Cupones, DATE_FORMAT(ce.Fecha_Inicio, '%Y-%m')
                ORDER BY month DESC
            `)
        ]);

        res.json({
            used: usedQuery,
            inUse: inUseQuery
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener estadísticas de cupones' });
    }
});

app.get('/api/admin/users-monthly', async (req, res) => {
    const { months = 6 } = req.query; 

    try {
        const query = `
            SELECT 
                DATE_FORMAT(c.Fecha_Creacion, '%Y-%m') as month,
                COUNT(DISTINCT c.ID_Usuario) as count
            FROM carrito c
            JOIN usuario u ON c.ID_Usuario = u.ID_Usuario
            WHERE c.Fecha_Creacion >= DATE_SUB(NOW(), INTERVAL ? MONTH)
            GROUP BY DATE_FORMAT(c.Fecha_Creacion, '%Y-%m')
            ORDER BY month ASC
        `;

        const results = await queryDatabase(query, [months]);
        
        const formattedResults = results.map(item => ({
            month: item.month,
            count: parseInt(item.count)
        }));

        const today = new Date();
        const startDate = new Date(today.getFullYear(), today.getMonth() - parseInt(months), 1);
        const months = [];
        
        for (let d = startDate; d <= today; d.setMonth(d.getMonth() + 1)) {
            const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const existingData = formattedResults.find(item => item.month === monthKey);
            months.push({
                month: monthKey,
                count: existingData ? existingData.count : 0
            });
        }

        res.json(months);
    } catch (error) {
        console.error('Error al obtener registro mensual de usuarios:', error);
        res.status(500).json({ error: 'Error al obtener registro mensual de usuarios' });
    }
});

// Endpoints para el Dashboard del Vendedor
app.get('/api/vendor/:userId/stats', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const productQuery = `
            SELECT COUNT(*) as total 
            FROM producto p
            JOIN tienda t ON p.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ?
        `;
        const productsResult = await queryDatabase(productQuery, [userId]);
        
        const orderQuery = `
            SELECT COUNT(DISTINCT p.ID_Pedido) as total
            FROM pedidos p
            JOIN pedido_producto pp ON p.ID_Pedido = pp.ID_Pedido
            JOIN producto pr ON pp.ID_Producto = pr.ID_Producto
            JOIN tienda t ON pr.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ?
        `;
        const ordersResult = await queryDatabase(orderQuery, [userId]);
        
        const revenueQuery = `
            SELECT 
                COALESCE(SUM(pp.Precio_Unitario * pp.Cantidad), 0) as total
            FROM pedidos p
            JOIN pedido_producto pp ON p.ID_Pedido = pp.ID_Pedido
            JOIN producto pr ON pp.ID_Producto = pr.ID_Producto
            JOIN tienda t ON pr.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ? AND p.Estado_Pedido = 'Completado'
        `;
        const revenueResult = await queryDatabase(revenueQuery, [userId]);
        
        const offersQuery = `
            SELECT COUNT(*) as total 
            FROM ofertas o
            JOIN tienda t ON o.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ? AND o.Activo = 1
        `;
        const offersResult = await queryDatabase(offersQuery, [userId]);
        
        const topProductsQuery = `
            SELECT 
                pr.Nombre_Producto as name,
                SUM(pp.Cantidad) as quantity,
                SUM(pp.Precio_Unitario * pp.Cantidad) as revenue
            FROM pedido_producto pp
            JOIN producto pr ON pp.ID_Producto = pr.ID_Producto
            JOIN tienda t ON pr.ID_Tienda = t.ID_Tienda
            JOIN pedidos p ON pp.ID_Pedido = p.ID_Pedido
            WHERE t.ID_Usuario = ? AND p.Estado_Pedido = 'Completado'
            GROUP BY pr.ID_Producto
            ORDER BY quantity DESC
            LIMIT 5
        `;
        const topProductsResult = await queryDatabase(topProductsQuery, [userId]);

        res.json({
            totalProducts: productsResult[0].total,
            totalOrders: ordersResult[0].total,
            totalRevenue: revenueResult[0].total,
            activeOffers: offersResult[0].total,
            topProducts: topProductsResult
        });
    } catch (error) {
        console.error('Error al obtener estadísticas del vendedor:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas del vendedor' });
    }
});

//ventas mensuales
app.get('/api/vendor/:userId/sales-monthly', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const query = `
            SELECT 
                DATE_FORMAT(p.Fecha_Pedido, '%Y-%m') as month,
                COUNT(DISTINCT p.ID_Pedido) as orders,
                SUM(pp.Precio_Unitario * pp.Cantidad) as revenue
            FROM pedidos p
            JOIN pedido_producto pp ON p.ID_Pedido = pp.ID_Pedido
            JOIN producto pr ON pp.ID_Producto = pr.ID_Producto
            JOIN tienda t ON pr.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ? 
            AND p.Estado_Pedido = 'Completado'
            AND p.Fecha_Pedido >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
            GROUP BY DATE_FORMAT(p.Fecha_Pedido, '%Y-%m')
            ORDER BY month DESC
        `;
        
        const results = await queryDatabase(query, [userId]);
        res.json(results);
    } catch (error) {
        console.error('Error al obtener ventas mensuales:', error);
        res.status(500).json({ error: 'Error al obtener ventas mensuales' });
    }
});



// Tendencias de ventas por día
app.get('/api/vendor/:userId/daily-sales-trend', async (req, res) => {
    const { userId } = req.params; 
    console.log('userId recibido:', userId); 
    console.log('Días solicitados:', req.query.days);
  
    try {

      const query = `
        SELECT 
          DATE(p.Fecha_Pedido) as date,
          COUNT(DISTINCT p.ID_Pedido) as total_orders,
          SUM(pp.Precio_Unitario * pp.Cantidad) as total_revenue
        FROM pedidos p
        JOIN pedido_producto pp ON p.ID_Pedido = pp.ID_Pedido
        JOIN producto pr ON pp.ID_Producto = pr.ID_Producto
        JOIN tienda t ON pr.ID_Tienda = t.ID_Tienda
        WHERE t.ID_Usuario = ? 
        AND p.Estado_Pedido = 'Completado'
        AND p.Fecha_Pedido >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(p.Fecha_Pedido)
        ORDER BY date DESC
      `;
      
     
      const results = await queryDatabase(query, [userId, req.query.days]);
  
   
      res.json(results);
    } catch (error) {
      console.error('Error al obtener ventas diarias:', error);
      res.status(500).json({ error: 'Error al obtener ventas diarias' });
    }
  });
  
//Productos en el carrito
app.get('/api/vendor/:userId/products-in-cart', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const query = `
            SELECT 
                pr.Nombre_Producto as name,
                SUM(cp.Cantidad) as quantity,
                SUM(cp.Subtotal) as revenue
            FROM carrito_producto cp
            JOIN producto pr ON cp.ID_Producto = pr.ID_Producto
            JOIN tienda t ON pr.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ?
            GROUP BY pr.ID_Producto
            ORDER BY quantity DESC
            LIMIT 5
        `;
        
        const results = await queryDatabase(query, [userId]);
        res.json(results);
    } catch (error) {
        console.error('Error al obtener productos en el carrito:', error);
        res.status(500).json({ error: 'Error al obtener productos en el carrito' });
    }
});

//cupones activos
app.get('/api/vendor/:userId/active-coupons', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const query = `
                c.Codigo as code,
                c.Descripcion as description,
                c.Descuento as discount,
                (SELECT COUNT(*) FROM cupones_usados WHERE ID_Cupon = c.ID_Cupones) as used_count
            FROM cupones c
            JOIN tienda t ON c.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ? 
                AND c.Activo = 1 
                AND c.Estado = 1
                AND (c.Fecha_Fin IS NULL OR c.Fecha_Fin > NOW())
            GROUP BY c.ID_Cupones
            ORDER BY used_count DESC
            LIMIT 5
        `;
        
        const results = await queryDatabase(query, [userId]);
        res.json(results);
    } catch (error) {
        console.error('Error al obtener cupones activos:', error);
        res.status(500).json({ error: 'Error al obtener cupones activos' });
    }
});

// Endpoint para obtener estadísticas de cupones usados y en uso
app.get('/api/vendor/:userId/coupons-usage', async (req, res) => {
    const { userId } = req.params;

    try {
        const usedCouponsQuery = `
            SELECT 
                c.Codigo,
                c.Descuento,
                DATE_FORMAT(cu.Fecha_Uso, '%Y-%m') as month,
                COUNT(*) as total_uses
            FROM cupones_usados cu
            JOIN cupones c ON cu.ID_Cupon = c.ID_Cupones
            JOIN tienda t ON c.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ?
            GROUP BY c.ID_Cupones, DATE_FORMAT(cu.Fecha_Uso, '%Y-%m')
            ORDER BY month DESC, total_uses DESC
        `;

        const inUseCouponsQuery = `
            SELECT 
                c.Codigo,
                c.Descuento,
                DATE_FORMAT(ce.Fecha_Inicio, '%Y-%m') as month,
                COUNT(*) as active_uses
            FROM cupones_en_uso ce
            JOIN cupones c ON ce.ID_Cupon = c.ID_Cupones
            JOIN tienda t ON c.ID_Tienda = t.ID_Tienda
            WHERE t.ID_Usuario = ?
            GROUP BY c.ID_Cupones, DATE_FORMAT(ce.Fecha_Inicio, '%Y-%m')
            ORDER BY month DESC, active_uses DESC
        `;

        const [usedCoupons, inUseCoupons] = await Promise.all([
            queryDatabase(usedCouponsQuery, [userId]),
            queryDatabase(inUseCouponsQuery, [userId])
        ]);

        const allMonths = [...new Set([
            ...usedCoupons.map(c => c.month),
            ...inUseCoupons.map(c => c.month)
        ])].sort();

        const combinedData = allMonths.map(month => {
            const usedInMonth = usedCoupons.find(c => c.month === month);
            const inUseInMonth = inUseCoupons.find(c => c.month === month);
            
            return {
                month,
                total_uses: usedInMonth ? usedInMonth.total_uses : 0,
                active_uses: inUseInMonth ? inUseInMonth.active_uses : 0,
                Codigo: usedInMonth ? usedInMonth.Codigo : (inUseInMonth ? inUseInMonth.Codigo : ''),
                Descuento: usedInMonth ? usedInMonth.Descuento : (inUseInMonth ? inUseInMonth.Descuento : 0)
            };
        });

        res.json({
            combined: combinedData,
            used: usedCoupons,
            inUse: inUseCoupons
        });

    } catch (error) {
        console.error('Error al obtener estadísticas de cupones:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas de cupones' });
    }
});

//#endregion


app.listen(3000, () => {
    console.log("Servidor prendido en el puerto 3000");
});