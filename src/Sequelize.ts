import { Sequelize, DataTypes, Model } from "sequelize";

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "./apbot.sqlite",
});

interface YamlAttributes {
  code: string;
  userId: string;
  filename: string;
  description: string;
  playerName: string[];
  games: string[];
}
class YamlTable extends Model<YamlAttributes, YamlAttributes> {
  public code!: string;
  public userId!: string;
  public filename!: string;
  public description!: string;
  public playerName!: string[];
  public games!: string[];

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}
YamlTable.init(
  {
    code: {
      type: DataTypes.STRING(4),
      primaryKey: true,
      validate: {
        is: /[A-Z]{4}/,
      },
    },
    userId: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    filename: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "No description provided",
    },
    playerName: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: ["Who?"],
    },
    games: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: ["A Link to the Past"],
    },
  },
  {
    sequelize,
    tableName: "yaml",
  },
);

interface PlayerAttributes {
  userId: string;
  defaultCode: string | null;
}
class PlayerTable extends Model<PlayerAttributes, PlayerAttributes> {
  public userId!: string;
  public defaultCode!: string | null;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}
PlayerTable.init(
  {
    userId: {
      type: DataTypes.STRING(20),
      primaryKey: true,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    defaultCode: {
      type: DataTypes.STRING(4),
      allowNull: true,
      defaultValue: null,
      validate: {
        is: /[A-Z]{4}/,
      },
    },
  },
  {
    sequelize,
    tableName: "players",
  },
);

interface GameAttributes {
  code: string;
  guildId: string;
  userId: string;
  filename: string;
  active: boolean;
}
class GameTable extends Model<GameAttributes, GameAttributes> {
  public code!: string;
  public guildId!: string;
  public userId!: string;
  public filename!: string;
  public active!: boolean;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}
GameTable.init(
  {
    code: {
      type: DataTypes.STRING(4),
      primaryKey: true,
      validate: {
        is: /[A-Z]{4}/,
      },
    },
    guildId: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    userId: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    filename: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    sequelize,
    tableName: "games",
  },
);

sequelize.sync();

export default sequelize;
export { YamlTable, PlayerTable, GameTable };
