import React from 'react';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogContentText from '@material-ui/core/DialogContentText';
import DialogTitle from '@material-ui/core/DialogTitle';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import { withStyles } from '@material-ui/core/styles';
import ipcPromise from 'ipc-promise';

const styles = theme => ({
  description: {
    marginBottom: theme.spacing.unit * 3,
  },
  directoryField: {
    display: 'flex',
    alignItems: 'flex-end',
  },
  textField: {
    flex: '1 0 auto',
    marginRight: theme.spacing.unit,
  },
});

class FormStartupDirectory extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      currentDirectory: props.appDirectory,
    };
  }

  handleSelectDirectoryClick = () => {
    ipcPromise.send('open-dialog', 'directory')
      .then((selectedDirectory) => {
        if (!selectedDirectory)
          return;

          this.setState({ currentDirectory: selectedDirectory[0] });
      });
  }

  submit = () => {
    const { currentDirectory } = this.state;
    this.props.onSubmit({ appDirectory: currentDirectory });
  }

  render() {
    const { open, close, classes } = this.props;
    const { currentDirectory } = this.state;

    return (
      <Dialog open={open} onClose={close}>
        <DialogTitle>
          Set Startup Directory
        </DialogTitle>
        <DialogContent>
          <DialogContentText className={classes.description}>
            You can select a new directory from where the application will run
          </DialogContentText>
          <div className={classes.directoryField}>
            <TextField
              label="Startup Directory"
              disabled
              value={currentDirectory}
              className={classes.textField}
            />
            <Button onClick={this.handleSelectDirectoryClick}>Select Directory</Button>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button color="primary" onClick={this.submit}>Submit</Button>
        </DialogActions>
      </Dialog>
    );
  }
}

export default withStyles(styles)(FormStartupDirectory);
