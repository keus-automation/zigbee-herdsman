import Database from '../database';
import {Adapter} from '../../adapter';
import events from 'events';

abstract class Entity extends events.EventEmitter {
    protected static databases: {[key: string]: Database} = {};
    protected static adapters: {[key: string]: Adapter} = {};

    public static injectDatabase(key: string, database: Database): void {
        Entity.databases[key] = database;
    }

    public static injectAdapter(key: string, adapter: Adapter): void {
        Entity.adapters[key] = adapter;
    }
}

export default Entity;
