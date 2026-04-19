import mongoose from 'mongoose';
import config from './index';
import logger from '../utils/logger';

export async function connectDB(): Promise<void> {
  try {
    await mongoose.connect(config.mongo.uri, {
      serverSelectionTimeoutMS: 10000,
    });
    logger.info(`MongoDB connecté : ${config.mongo.uri}`);
  } catch (err) {
    logger.error('Erreur connexion MongoDB', err);
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB error', err);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB déconnecté');
  });
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
